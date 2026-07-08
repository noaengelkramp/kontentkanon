import "dotenv/config";
import express from "express";
import cors from "cors";
import { createRequire } from "module";
import { createManagementClient } from "@kontent-ai/management-sdk";
import serverless from "serverless-http";

// createRequire needs an absolute path or file URL.
// import.meta.url is undefined when esbuild compiles to CJS (Netlify Lambda).
// Fall back through __filename (CJS) → process.cwd() so it always works.
const _require = (() => {
  try {
    if (typeof import.meta !== "undefined" && import.meta.url)
      return createRequire(import.meta.url);
  } catch (_) {}
  try {
    if (typeof __filename !== "undefined" && __filename)
      return createRequire(__filename);
  } catch (_) {}
  return createRequire(`file://${process.cwd()}/server.js`);
})();

const app = express();
app.use(cors());
app.use(express.json());

// ---- Kontent client ----
let client;
try {
  if (!process.env.KONTENT_ENV_ID || !process.env.KONTENT_API_KEY) {
    throw new Error("KONTENT_ENV_ID or KONTENT_API_KEY not set in environment variables.");
  }
  client = createManagementClient({
    environmentId: process.env.KONTENT_ENV_ID,
    apiKey: process.env.KONTENT_API_KEY
  });
} catch (e) {
  console.error("[ERROR] Failed to initialize Kontent Management Client:", e.message);
  client = null; 
}

// ===== CACHES =====
let stepToWorkflow = new Map();
let cacheInitialized = false;

// ---- Load languages & workflow data ----
// These are inlined by esbuild at build time via createRequire — no runtime file I/O needed.
let _languagesJson, _workflowJson;
try {
  _languagesJson = _require("./languages.json");
  _workflowJson  = _require("./workflow.json");
  console.log("Loaded languages.json and workflow.json via require");
} catch (e) {
  console.error("Failed to require JSON files:", e.message);
  _languagesJson = { languages: [] };
  _workflowJson  = [];
}

let activeLanguages = ((_languagesJson.languages || []))
  .filter(l => l.is_active)
  .map(l => ({ id: l.id, name: l.name, codename: l.codename }));

const _localWfRaw = Array.isArray(_workflowJson) ? _workflowJson[0] : _workflowJson;

let workflowStepsForUi = [
  ...(_localWfRaw?.steps || []),
  _localWfRaw?.published_step ? { ..._localWfRaw.published_step, published: true } : null,
  _localWfRaw?.archived_step ? { ..._localWfRaw.archived_step, archived: true } : null,
  _localWfRaw?.scheduled_step ? { ..._localWfRaw.scheduled_step, scheduled: true } : null,
].filter(Boolean).map(s => ({
  id: s.id,
  name: s.name,
  codename: s.codename,
  published: !!s.published,
  archived: !!s.archived,
  scheduled: !!s.scheduled
}));

// If the static JSON was empty, try fetching from the live API on first request
async function ensureInitialized() {
  if (cacheInitialized) return;
  cacheInitialized = true;

  // Only attempt live API hydration if static data was missing
  if (activeLanguages.length === 0 && client) {
    try {
      const { data } = await client.listLanguages().toPromise();
      activeLanguages = (data?.items || [])
        .filter(l => l.isActive)
        .map(l => ({ id: l.id, name: l.name, codename: l.codename }));
      console.log("Hydrated languages from API:", activeLanguages.length);
    } catch (e) {
      console.error("Failed to hydrate languages from API:", e.message);
    }
  }

  if (workflowStepsForUi.length === 0 && client) {
    try {
      const { data } = await client.listWorkflows().toPromise();
      const workflows = data?.items || data || [];
      const wf = workflows[0];
      if (wf) {
        workflowStepsForUi = [
          ...(wf.steps || []),
          wf.publishedStep ? { ...wf.publishedStep, published: true } : null,
          wf.archivedStep ? { ...wf.archivedStep, archived: true } : null,
          wf.scheduledStep ? { ...wf.scheduledStep, scheduled: true } : null,
        ].filter(Boolean).map(s => ({
          id: s.id,
          name: s.name,
          codename: s.codename,
          published: !!s.published,
          archived: !!s.archived,
          scheduled: !!s.scheduled
        }));
        console.log("Hydrated workflow steps from API:", workflowStepsForUi.length);
      }
    } catch (e) {
      console.error("Failed to hydrate workflows from API:", e.message);
    }
  }
}

// ===== HYDRATORS =====
async function hydrateWorkflows() {
  if (!client) return;
  stepToWorkflow = new Map();
  const { data } = await client.listWorkflows().toPromise();
  const workflows = data?.items || data || [];
  for (const wf of workflows) {
    (wf.steps || []).forEach(st => stepToWorkflow.set(st.id, wf.id));
    // SDK returns camelCase properties
    const pubStep = wf.publishedStep ?? wf.published_step;
    const arcStep = wf.archivedStep ?? wf.archived_step;
    const schStep = wf.scheduledStep ?? wf.scheduled_step;
    if (pubStep?.id) stepToWorkflow.set(pubStep.id, wf.id);
    if (arcStep?.id) stepToWorkflow.set(arcStep.id, wf.id);
    if (schStep?.id) stepToWorkflow.set(schStep.id, wf.id);
  }
  console.log(`stepToWorkflow populated: ${stepToWorkflow.size} entries`);
}

// ---- Utils ----
function splitIds(s) {
  return Array.from(new Set(String(s || "").split(/[,\s]+/).map(x => x.trim()).filter(Boolean)));
}

async function backoff(fn, tries = 5, startMs = 500) {
  let wait = startMs;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      const status = e?.originalError?.response?.status || e?.response?.status || e?.status;
      if (![429, 500, 502, 503, 504].includes(status) || i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, wait));
      wait = Math.min(wait * 2, 8000);
    }
  }
}

async function runWithConcurrency(tasks, limit, fn) {
  const results = new Array(tasks.length);
  const executing = new Set();
  
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const p = (async () => {
      try {
        const res = await fn(task);
        results[i] = res;
      } catch (err) {
        results[i] = { error: err.message };
      }
    })();
    
    executing.add(p);
    p.then(() => executing.delete(p));
    
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}

// ===== GRAPH TRAVERSAL HELPERS =====
function extractLinkedIdsFromValue(val) {
    const ids = [];
    if (!val) return ids;
  
    if (Array.isArray(val)) {
        val.forEach(v => {
            if (v?.id) ids.push(v.id);
        });
    } else if (typeof val === 'string' && val.includes('data-item-id')) {
      const re = /data-item-id="([0-9a-f-]{36})"/gi;
      let m;
      while ((m = re.exec(val)) !== null) {
        ids.push(m[1]);
      }
    }
    return [...new Set(ids)];
}

async function getItemBundle(itemId, languageCodename) {
    if (!client) return { item: null, variant: null, links: [] };
    let item, variant = null;
    try {
      const { data } = await client.viewContentItem().byItemId(itemId).toPromise();
      item = data || null;
    } catch (e) {
      if (e?.originalError?.response?.status !== 404) console.error(`[ERROR] Failed to fetch item ${itemId}:`, e?.message);
      return { item: null, variant: null, links: [] };
    }
  
    try {
      const { data } = await client.viewLanguageVariant().byItemId(itemId).byLanguageCodename(languageCodename).toPromise();
      variant = data || null;
    } catch (e) {
      if (e?.originalError?.response?.status !== 404) console.error(`[ERROR] Failed to fetch variant ${itemId}/${languageCodename}:`, e?.message);
      return { item, variant: null, links: [] };
    }
  
    const links = new Set();
    if (variant?.elements) {
        for (const el of variant.elements) {
            extractLinkedIdsFromValue(el.value).forEach(id => links.add(id));
        }
    }
    return { item, variant, links: Array.from(links) };
}

// Helper: Fetch multiple items in parallel with concurrency limit
async function fetchItemBundlesBatch(itemIds, languageCodename, concurrency = 2) {
  const results = [];
  
  for (let i = 0; i < itemIds.length; i += concurrency) {
    const batch = itemIds.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(id => getItemBundle(id, languageCodename))
    );
    results.push(...batchResults);
  }
  
  return results;
}

// ===== DUPLICATION LOGIC =====
async function duplicateItemDeep(sourceItemId, sourceLanguage, targetLanguages, options) {
    const {
        namePrefix = "Copy of ",
        nameSuffix = "",
        nameOverrides = {},
        collectionId = null,
        existingIdMap,
        duplicateLinkedItems = false,
        itemsToDuplicate = [],
        errors,
        results,
        currentDepth = 0,
        maxDepth = 10,
    } = options;

    if (!client) {
        errors.push({ itemId: sourceItemId, error: `Kontent Management Client failed to initialize.` });
        return;
    }

    if (currentDepth >= maxDepth) return;
    if (existingIdMap.has(sourceItemId)) return;
    existingIdMap.set(sourceItemId, null);

    let sourceItem, sourceVariant;
    
    try {
        sourceItem = (await backoff(() => client.viewContentItem().byItemId(sourceItemId).toPromise())).data;

        try {
            sourceVariant = (await backoff(() => client.viewLanguageVariant().byItemId(sourceItemId).byLanguageCodename(sourceLanguage).toPromise())).data;
        } catch (variantError) {
            if (variantError?.originalError?.response?.status === 404) {
                errors.push({ itemId: sourceItemId, itemName: sourceItem.name, error: `Skipped: source language '${sourceLanguage}' variant does not exist.`, skipped: true });
                existingIdMap.delete(sourceItemId);
                return;
            }
            throw variantError;
        }

        if (duplicateLinkedItems && sourceVariant.elements) {
            const linkedItemIdsToRecurse = new Set();
            for (const element of sourceVariant.elements) {
                extractLinkedIdsFromValue(element.value).forEach(id => linkedItemIdsToRecurse.add(id));
            }
            for (const linkedId of linkedItemIdsToRecurse) {
                // Only recurse if item is in the selected list
                if (itemsToDuplicate.includes(linkedId)) {
                    await duplicateItemDeep(linkedId, sourceLanguage, targetLanguages, { ...options, currentDepth: currentDepth + 1 });
                }
            }
        }

        const newName = nameOverrides[sourceItemId] || `${namePrefix}${sourceItem.name}${nameSuffix}`;
        const typeReference = sourceItem.type.codename ? { codename: sourceItem.type.codename } : { id: sourceItem.type.id };

        const newItemData = { name: newName, type: typeReference };
        if (collectionId) {
            newItemData.collection = { id: collectionId };
        } else if (sourceItem.collection?.id && sourceItem.collection.id !== '00000000-0000-0000-0000-000000000000') {
            newItemData.collection = { id: sourceItem.collection.id };
        }
        if (Array.isArray(sourceItem.sitemap_locations) && sourceItem.sitemap_locations.length > 0) {
          newItemData.sitemap_locations = sourceItem.sitemap_locations;
        }

        const newItem = (await backoff(() => client.addContentItem().withData(newItemData).toPromise())).data;

        existingIdMap.set(sourceItemId, newItem.id);
        results.push({ sourceId: sourceItemId, sourceName: sourceItem.name, newId: newItem.id, newName: newItem.name, type: sourceItem.type.codename });

        const upsertPayload = {};
        const newElements = [];

        if (sourceVariant.elements) {
          for (const element of sourceVariant.elements) {
              if (element.mode === 'autogenerated') {
                  newElements.push({ element: { id: element.element.id }, mode: 'autogenerated' });
                  continue;
              }
              let newValue = element.value;
              const originalLinkedIds = extractLinkedIdsFromValue(element.value);
              if (originalLinkedIds.length > 0) {
                  const combinedIds = new Set();
                  originalLinkedIds.forEach(id => {
                      // If item was selected for duplication AND has been duplicated, use new ID
                      if (itemsToDuplicate.includes(id) && existingIdMap.has(id) && existingIdMap.get(id)) {
                          combinedIds.add(existingIdMap.get(id));
                      } else {
                          // Otherwise keep original
                          combinedIds.add(id);
                      }
                  });
                  newValue = Array.from(combinedIds).map(id => ({ id }));
              }
              newElements.push({ element: { id: element.element.id }, value: newValue });
          }
        }
        upsertPayload.elements = newElements;

        const draftStep = workflowStepsForUi.find(s => s.codename === 'draft');
        if (draftStep && stepToWorkflow.has(draftStep.id)) {
            upsertPayload.workflow = {
                workflow_identifier: { id: stepToWorkflow.get(draftStep.id) },
                step_identifier: { id: draftStep.id },
            };
        }

        for (const targetLang of targetLanguages) {
            const url = `https://manage.kontent.ai/v2/projects/${process.env.KONTENT_ENV_ID}/items/${newItem.id}/variants/codename/${targetLang}`;
            const fetchOptions = {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${process.env.KONTENT_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(upsertPayload)
            };
            await backoff(async () => {
                const response = await fetch(url, fetchOptions);
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const error = new Error(`Upsert failed: ${errorData.message || response.statusText}`);
                    error.status = response.status;
                    throw error;
                }
                return response.json();
            });
        }
    } catch (error) {
        errors.push({
            itemId: sourceItemId,
            itemName: sourceItem?.name || '(unknown)',
            error: error.message || 'An unknown error occurred.',
        });
        if (existingIdMap.get(sourceItemId) === null) {
            existingIdMap.delete(sourceItemId);
        }
    }
}

// ===== API ENDPOINTS =====
app.get("/api/meta/languages", async (_req, res) => { 
  await ensureInitialized(); 
  res.json({ languages: activeLanguages }); 
});

app.get("/api/meta/workflow-steps", async (_req, res) => { 
  await ensureInitialized(); 
  res.json({ steps: workflowStepsForUi }); 
});

// ===== GRAPH TRAVERSAL WITH BATCHING =====
app.post("/api/graph/query", async (req, res) => {
  try {
    await ensureInitialized();
    if (!client) return res.status(500).json({ error: "Client not initialized." });
    
    const {
      rootItemIds = [],
      languageCodename,
      layerElementCodename = "layer",
      layerFilterIn,
      typeFilterIn,
      maxNodes = 2000,
      continueFrom = null  // For pagination: { processedIds: [], queuedIds: [] }
    } = req.body || {};

    if (!Array.isArray(rootItemIds) || !rootItemIds.length) {
      return res.status(400).json({ error: "Provide rootItemIds" });
    }
    if (!languageCodename) {
      return res.status(400).json({ error: "Provide languageCodename" });
    }

    // Track execution time to prevent timeouts
    const startTime = Date.now();
    // Very conservative timeouts: 15s for production, 20s for local/other
    const maxExecutionTime = process.env.NETLIFY ? 15000 : 20000;

    // Initialize or continue from previous state
    const seen = continueFrom?.processedIds 
      ? new Set([...continueFrom.processedIds, ...continueFrom.queuedIds]) 
      : new Set(rootItemIds);
    const queue = continueFrom?.queuedIds ? [...continueFrom.queuedIds] : [...rootItemIds];
    const results = [];
    
    // Process in batches with parallel fetching
    // Small batches to avoid timeout
    const BATCH_SIZE = 3; // Process only 3 items at a time

    while (queue.length > 0 && results.length < maxNodes) {
      // Check timeout BEFORE starting batch processing
      const elapsed = Date.now() - startTime;
      if (elapsed > maxExecutionTime) {
        console.warn(`Graph query timeout: processed ${results.length} items, ${queue.length} remaining (${elapsed}ms elapsed)`);
        return res.json({
          count: results.length,
          items: results,
          incomplete: true,
          continueFrom: {
            processedIds: Array.from(seen).filter(id => !queue.includes(id)),
            queuedIds: queue
          }
        });
      }
      
      // Get next batch
      const batchIds = queue.splice(0, Math.min(BATCH_SIZE, queue.length));
      
      // Fetch batch in parallel with reduced concurrency
      const bundles = await fetchItemBundlesBatch(batchIds, languageCodename, 2);
      
      console.log(`Processing batch: ${batchIds.length} items, got ${bundles.filter(b => b.item).length} valid bundles`);
      
      for (const { item, links } of bundles) {
        if (!item) continue;
        
        console.log(`Item ${item.id}: ${item.name}, found ${links.length} linked items`);

        results.push({
          id: item.id,
          name: item.name,
          typeCodename: item.type.codename,
          linkedCount: links.length,
          layerValues: [] // Can be enhanced to extract layer values if needed
        });

        // Add linked items to queue
        for (const childId of links) {
          if (!seen.has(childId)) {
            seen.add(childId);
            queue.push(childId);
          }
        }
      }
      
      console.log(`After batch: results=${results.length}, queue=${queue.length}, seen=${seen.size}`);
    }

    // Apply filters
    const layerSet = new Set((Array.isArray(layerFilterIn) ? layerFilterIn : String(layerFilterIn || "").split(/[\s,]+/)).filter(Boolean).map(x => x.toLowerCase()));
    const typeSet = new Set((Array.isArray(typeFilterIn) ? typeFilterIn : String(typeFilterIn || "").split(/[\s,]+/)).filter(Boolean).map(x => x.toLowerCase()));

    let out = results;
    if (layerSet.size) {
      out = out.filter(r => (r.layerValues || []).some(v => layerSet.has(String(v).toLowerCase())));
    }
    if (typeSet.size) {
      out = out.filter(r => typeSet.has(String(r.typeCodename).toLowerCase()));
    }

    // Check if there might be more items to process
    const hasMoreItems = queue.length > 0;
    
    res.json({ 
      count: out.length, 
      items: out,
      incomplete: hasMoreItems,
      continueFrom: hasMoreItems ? {
        processedIds: Array.from(seen).filter(id => !queue.includes(id)),
        queuedIds: queue
      } : null
    });
  } catch (e) {
    console.error("Error in graph query:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});
  
app.post("/api/workflow", async (req, res) => {
    try {
        await ensureInitialized();
        if (!client) return res.status(500).json({ error: "Client not initialized." });

        const { itemIds, languageCodenames, workflowStepId, dryRun, scheduleTime, continueFrom } = req.body;
        const ids = splitIds(itemIds);
        const langs = languageCodenames || [];
        if (!ids.length || !langs.length || !workflowStepId) return res.status(400).json({ error: "Missing parameters" });

        const targetStep = workflowStepsForUi.find(s => s.id === workflowStepId);
        if (!targetStep) return res.status(400).json({ error: "Invalid workflow step" });

        if (stepToWorkflow.size === 0) await hydrateWorkflows();

        // Build the full flat list of operations
        const allOperations = [];
        for (const id of ids) {
            for (const lang of langs) {
                allOperations.push({ id, lang });
            }
        }

        // Support continuation: resume from where we left off
        const startIndex = continueFrom?.nextIndex ?? 0;
        const slice = allOperations.slice(startIndex);

        // Timeout guard — leave 3s headroom under Netlify's 20s limit
        const MAX_MS = 12000;
        const startTime = Date.now();

        const results = [];

        if (dryRun) {
            return res.json({ results: slice.map(({ id, lang }) => ({ id, lang, status: "DRY_RUN" })) });
        }

        // Process in sub-batches of 5, checking elapsed time between each batch
        const BATCH = 5;
        let processedCount = 0;

        for (let i = 0; i < slice.length; i += BATCH) {
            // Timeout check before every batch
            if (Date.now() - startTime > MAX_MS) {
                const nextIndex = startIndex + processedCount;
                console.warn(`Workflow timeout guard hit after ${processedCount} ops. Returning continuation at index ${nextIndex}.`);
                return res.json({
                    results,
                    incomplete: true,
                    continueFrom: { nextIndex }
                });
            }

            const batch = slice.slice(i, i + BATCH);
            const batchResults = await runWithConcurrency(batch, 5, async ({ id, lang }) => {
                try {
                    if (targetStep.published) {
                        if (scheduleTime) {
                            await backoff(() => client.publishLanguageVariant().byItemId(id).byLanguageCodename(lang).withData({ scheduled_to: scheduleTime }).toPromise());
                            return { id, lang, status: "SCHEDULED" };
                        }
                        await backoff(() => client.publishLanguageVariant().byItemId(id).byLanguageCodename(lang).withData({}).toPromise());
                        return { id, lang, status: "PUBLISHED" };
                    }
                    if (targetStep.archived) {
                        await backoff(() => client.unpublishLanguageVariant().byItemId(id).byLanguageCodename(lang).withData({}).toPromise());
                        return { id, lang, status: "UNPUBLISHED" };
                    }
                    if (targetStep.scheduled) {
                        if (!scheduleTime) throw new Error("Schedule time required");
                        await backoff(() => client.publishLanguageVariant().byItemId(id).byLanguageCodename(lang).withData({ scheduled_to: scheduleTime }).toPromise());
                        return { id, lang, status: "SCHEDULED" };
                    }

                    // Regular workflow step
                    const wfId = stepToWorkflow.get(workflowStepId);
                    if (!wfId) throw new Error("Cannot resolve workflow");

                    try {
                        await backoff(() => client.changeWorkflowOfLanguageVariant().byItemId(id).byLanguageCodename(lang).withData({ workflow_identifier: { id: wfId }, step_identifier: { id: workflowStepId } }).toPromise());
                        return { id, lang, status: "MOVED" };
                    } catch (changeError) {
                        const errorCode = changeError?.response?.data?.error_code || changeError?.originalError?.response?.data?.error_code;
                        if (errorCode === 4040012) {
                            await backoff(() => client.createNewVersionOfLanguageVariant().byItemId(id).byLanguageCodename(lang).toPromise());
                            const draftStep = workflowStepsForUi.find(s => s.codename === 'draft');
                            if (workflowStepId !== draftStep?.id) {
                                await backoff(() => client.changeWorkflowOfLanguageVariant().byItemId(id).byLanguageCodename(lang).withData({ workflow_identifier: { id: wfId }, step_identifier: { id: workflowStepId } }).toPromise());
                            }
                            return { id, lang, status: "NEW_VERSION_CREATED" };
                        }
                        throw changeError;
                    }
                } catch (e) {
                    const errorCode = e?.response?.data?.error_code || e?.originalError?.response?.data?.error_code;
                    const errorMsg = e?.response?.data?.message || e?.originalError?.response?.data?.message || e?.message || 'Unknown error';
                    if (errorCode === 215) return { id, lang, status: "ALREADY_IN_STATE", message: "Item already in target workflow state" };
                    return { id, lang, status: "ERROR", message: errorMsg, errorCode };
                }
            });

            results.push(...batchResults);
            processedCount += batch.length;
        }

        res.json({ results, incomplete: false });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
  
app.post("/api/delete", async (req, res) => {
    try {
        await ensureInitialized();
        if (!client) return res.status(500).json({ error: "Client not initialized." });
        const { itemIds, deleteMode, languageCodenames, dryRun } = req.body;
        const ids = splitIds(itemIds);
        if (!ids.length) return res.status(400).json({ error: "No IDs" });
        
        const results = [];
        if (deleteMode === 'item') {
            const tasks = ids.map(id => ({ id }));
            const executionResults = await runWithConcurrency(tasks, 5, async ({ id }) => {
                if (dryRun) return { id, status: "DRY_RUN_ITEM" };
                try {
                    await backoff(() => client.deleteContentItem().byItemId(id).toPromise());
                    return { id, status: "DELETED_ITEM" };
                } catch (e) { 
                    return { id, status: "ERROR", message: e.message }; 
                }
            });
            results.push(...executionResults);
        } else {
            const langs = languageCodenames || [];
            if (!langs.length) return res.status(400).json({ error: "No languages" });
            
            const tasks = [];
            for (const id of ids) {
                for (const lang of langs) {
                    tasks.push({ id, lang });
                }
            }
            
            const executionResults = await runWithConcurrency(tasks, 5, async ({ id, lang }) => {
                if (dryRun) return { id, lang, status: "DRY_RUN_VARIANT" };
                try {
                    await backoff(() => client.deleteLanguageVariant().byItemId(id).byLanguageCodename(lang).toPromise());
                    return { id, lang, status: "DELETED_VARIANT" };
                } catch (e) { 
                    return { id, status: "ERROR", message: e.message }; 
                }
            });
            results.push(...executionResults);
        }
        res.json({ results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/duplicate", async (req, res) => {
  try {
    await ensureInitialized();
    if (!client) return res.status(500).json({ error: "Client not initialized." });
    if (stepToWorkflow.size === 0) await hydrateWorkflows();
    
    const {
      sourceItemId,
      sourceItemIds,
      sourceLanguage,
      targetLanguages,
      dryRun = false,
      maxDepth = 10,
    } = req.body;

    const itemsToProcess = sourceItemIds || (sourceItemId ? [sourceItemId] : []);
    if (itemsToProcess.length === 0) return res.status(400).json({ error: "sourceItemId or sourceItemIds is required" });
    if (!sourceLanguage) return res.status(400).json({ error: "sourceLanguage is required" });

    const finalTargetLangs = targetLanguages?.length ? targetLanguages : [sourceLanguage];

    if (dryRun) {
        const rootId = itemsToProcess[0];
        const queue = [{ id: rootId, depth: 0 }];
        const seen = new Set([rootId]);
        const preview = [];
  
        while (queue.length > 0 && preview.length < maxDepth * 100) {
          const { id, depth } = queue.shift();
          if (depth >= maxDepth) continue;
          try {
            const { item: currentItem, links: currentLinks } = await getItemBundle(id, sourceLanguage);
            if (currentItem) {
              preview.push({ id: currentItem.id, name: currentItem.name, type: currentItem.type.codename, depth, linkedCount: currentLinks.length });
              for (const linkedId of currentLinks) {
                if (!seen.has(linkedId)) {
                  seen.add(linkedId);
                  queue.push({ id: linkedId, depth: depth + 1 });
                }
              }
            }
          } catch(e) {
              console.error(`Dry run failed for item ${id}: ${e.message}`);
          }
        }
        return res.json({ action: "duplicate", dryRun: true, preview, totalItems: preview.length, targetLanguages: finalTargetLangs });
    }

    const results = [];
    const errors = [];
    const idMap = new Map();

    // Pass itemsToDuplicate to the duplication function
    for (const itemId of itemsToProcess) {
      await duplicateItemDeep(itemId, sourceLanguage, finalTargetLangs, { 
        ...req.body, 
        results, 
        errors, 
        existingIdMap: idMap,
        itemsToDuplicate: itemsToProcess 
      });
    }

    res.json({
      action: "duplicate",
      success: errors.filter(e => !e.skipped).length === 0,
      idMap: Object.fromEntries(idMap),
      results,
      errors,
      totalDuplicated: results.length,
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export const handler = serverless(app);

// Start standalone local server when run directly (not as a Netlify function)
if (!process.env.NETLIFY && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Standalone local server running at http://localhost:${PORT}`));
}