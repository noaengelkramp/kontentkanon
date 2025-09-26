import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createManagementClient } from "@kontent-ai/management-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serves public/index.html

// ---- Kontent client ----
const client = createManagementClient({
  environmentId: process.env.KONTENT_ENV_ID,
  apiKey: process.env.KONTENT_API_KEY
});

// ===== CACHES =====
let typeLinkElementMap = new Map();            // typeCodename -> { linked:Set, richtext:Set } (best-effort)
let stepToWorkflow = new Map();                // stepId -> workflowId mapping from live API

// ---- Load languages & workflow (for UI only) ----
const languagesJson = JSON.parse(fs.readFileSync(path.join(__dirname, "languages.json"), "utf-8"));
const activeLanguages = (languagesJson.languages || [])
  .filter(l => l.is_active)
  .map(l => ({ id: l.id, name: l.name, codename: l.codename }));

const localWfRaw = JSON.parse(fs.readFileSync(path.join(__dirname, "workflow.json"), "utf-8"));
const localWf = Array.isArray(localWfRaw) ? localWfRaw[0] : localWfRaw;

const workflowStepsForUi = [
  ...(localWf.steps || []),
  localWf.published_step ? { ...localWf.published_step, published: true } : null,
  localWf.archived_step ? { ...localWf.archived_step, archived: true } : null,
  localWf.scheduled_step ? { ...localWf.scheduled_step, scheduled: true } : null
].filter(Boolean).map(s => ({
  id: s.id,
  name: s.name,
  codename: s.codename,
  published: !!s.published,
  archived: !!s.archived,
  scheduled: !!s.scheduled
}));

// ===== HYDRATORS =====
async function hydrateWorkflows() {
  stepToWorkflow = new Map();
  const { data } = await client.listWorkflows().toPromise();
  const workflows = data?.items || data || [];
  for (const wf of workflows) {
    (wf.steps || []).forEach(st => stepToWorkflow.set(st.id, wf.id));
    if (wf.published_step?.id) stepToWorkflow.set(wf.published_step.id, wf.id);
    if (wf.archived_step?.id) stepToWorkflow.set(wf.archived_step.id, wf.id);
    if (wf.scheduled_step?.id) stepToWorkflow.set(wf.scheduled_step.id, wf.id);
  }
  console.log(`Built stepToWorkflow mapping with ${stepToWorkflow.size} entries`);
}

async function hydrateTypeSchemas() {
  try {
    typeLinkElementMap.clear();
    const { data } = await client.listContentTypes().toPromise();
    const types = data?.items || data || [];
    console.log("Processing types:", types.length);
    
    for (const t of types) {
      const linked = new Set();
      const richtext = new Set();
      for (const el of (t.elements || [])) {
        const code = el?.codename;
        if (!code) continue;
        if (el.type === "modular_content") linked.add(code);
        if (el.type === "rich_text") richtext.add(code);
      }
      typeLinkElementMap.set(t.codename, { linked, richtext });
      console.log(`Type ${t.codename}: linked=${linked.size}, richtext=${richtext.size}`);
    }
    console.log("Type schemas loaded:", typeLinkElementMap.size);
  } catch (e) {
    console.error("Type schema hydration failed:", e?.message || e);
  }
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
      const status = e?.originalError?.response?.status || e?.response?.status;
      if (![429, 500, 502, 503, 504].includes(status) || i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, wait));
      wait = Math.min(wait * 2, 8000);
    }
  }
}

function isPublishGuardError(err) {
  const msg = (err?.originalError?.response?.data?.message
    || err?.response?.data?.message
    || err?.message
    || "").toLowerCase();
  const code = err?.originalError?.response?.status || err?.response?.status;
  return code === 400 || code === 409 || msg.includes("cannot change workflow step from publish");
}

async function createNewVersion(itemId, languageCodename) {
  await backoff(() =>
    client.createNewVersionOfLanguageVariant()
      .byItemId(itemId)
      .byLanguageCodename(languageCodename)
      .toPromise()
  );
}

// ===== GRAPH TRAVERSAL HELPERS =====

// Extract linked item IDs from various shapes (linked-items, rich text, components, HTML fallback)
function extractLinkedIdsFromValue(val) {
  const ids = [];
  if (!val) return ids;

  console.log("Analyzing value:", typeof val, val);

  // Handle different value structures
  
  // 1. Direct array of IDs (modular_content elements)
  if (Array.isArray(val)) {
    console.log("Processing array with", val.length, "items");
    for (const v of val) {
      if (typeof v === "string" && v.match(/^[0-9a-f-]{36}$/i)) {
        console.log("Found direct ID:", v);
        ids.push(v);
      } else if (v?.id && typeof v.id === "string") {
        console.log("Found object with ID:", v.id);
        ids.push(v.id);
      }
    }
  }

  // 2. Rich text with linked_items or linked_item_ids
  if (val && typeof val === "object") {
    // Check for linked_item_ids array
    if (Array.isArray(val.linked_item_ids)) {
      console.log("Found linked_item_ids:", val.linked_item_ids.length);
      ids.push(...val.linked_item_ids);
    }
    
    // Check for linked_items array
    if (Array.isArray(val.linked_items)) {
      console.log("Found linked_items:", val.linked_items.length);
      for (const item of val.linked_items) {
        if (item?.id) ids.push(item.id);
      }
    }

    // Check for components in rich text
    if (Array.isArray(val.components)) {
      console.log("Found components:", val.components.length);
      for (const comp of val.components) {
        // Components themselves have IDs
        if (comp?.id) {
          console.log("Found component ID:", comp.id);
          ids.push(comp.id);
        }
        
        // Components may also have elements with more linked items
        if (Array.isArray(comp.elements)) {
          for (const element of comp.elements) {
            const subIds = extractLinkedIdsFromValue(element.value);
            if (subIds.length) {
              console.log("Found sub-component IDs:", subIds.length);
              ids.push(...subIds);
            }
          }
        }
      }
    }

    // Check for modular_content array (alternative structure)
    if (Array.isArray(val.modular_content)) {
      console.log("Found modular_content:", val.modular_content.length);
      for (const item of val.modular_content) {
        if (item?.id) ids.push(item.id);
      }
    }
  }

  // 3. Fallback: parse HTML strings for data-item-id attributes
  if (typeof val === "string") {
    if (val.includes("data-item-id")) {
      const re = /data-item-id="([0-9a-f-]{36})"/gi;
      let m;
      while ((m = re.exec(val)) !== null) {
        console.log("Found HTML embedded ID:", m[1]);
        ids.push(m[1]);
      }
    }
    
    // Also check if the string itself is a UUID
    if (val.match(/^[0-9a-f-]{36}$/i)) {
      console.log("Value is direct UUID:", val);
      ids.push(val);
    }
  }

  const uniqueIds = [...new Set(ids)];
  console.log("Extracted", uniqueIds.length, "unique IDs from value");
  return uniqueIds;
}

// Flatten API variant elements into a simple map { elementId: value }
// Note: Management API returns element IDs, not codenames in the response
function readElementsMap(variant) {
  const out = {};
  (variant?.elements || []).forEach(el => {
    const id = el?.element?.id;
    if (id) {
      console.log(`Element ${id}: value=`, el.value);
      out[id] = el.value;
    }
  });
  console.log("Elements map keys:", Object.keys(out));
  return out;
}

// Resolve edge fields using element IDs (since Management API uses IDs, not codenames in responses)
function getLinkElementCandidates(typeCodename, elementsMap) {
  console.log(`Getting link candidates for type: ${typeCodename}`);
  console.log(`Elements map has ${Object.keys(elementsMap).length} elements`);
  
  // Since Management API returns element IDs (not codenames), we need to check all elements by shape
  const candidates = [];
  
  for (const [elementId, val] of Object.entries(elementsMap)) {
    console.log(`Analyzing element ${elementId}:`, typeof val, Array.isArray(val) ? `array[${val.length}]` : 'non-array');
    const extractedIds = extractLinkedIdsFromValue(val);
    if (extractedIds.length > 0) {
      console.log(`✓ Element ${elementId} contains ${extractedIds.length} linked items:`, extractedIds);
      candidates.push(elementId);
    }
  }

  console.log(`Final candidates: ${candidates.length} elements with links`);
  return candidates;
}

// Fetch "full item view": item metadata + language variant + outgoing links
async function getItemBundle(itemId, languageCodename) {
  console.log(`Fetching bundle for item ${itemId} in ${languageCodename}`);
  
  // 1) metadata
  let item = null;
  try {
    const { data } = await client.viewContentItem().byItemId(itemId).toPromise();
    item = data || null;
    console.log(`Item metadata retrieved: ${item?.name || 'unnamed'} (${item?.type?.codename})`);
  } catch (e) {
    console.error(`Failed to fetch item ${itemId}:`, e?.message);
    // not found or no access
    return { item: null, variant: null, links: [] };
  }

  // 2) language variant (elements)
  let variant = null;
  try {
    const { data } = await client
      .viewLanguageVariant()
      .byItemId(itemId)
      .byLanguageCodename(languageCodename)
      .toPromise();
    variant = data || null;
    console.log(`Variant retrieved for ${languageCodename}, elements count:`, variant?.elements?.length || 0);
  } catch (e) {
    console.error(`Failed to fetch variant ${itemId}/${languageCodename}:`, e?.message);
    // no variant in that language
    return { item, variant: null, links: [] };
  }

  // 3) compute outgoing links from elements (linked items + rich text)
  const elementsMap = readElementsMap(variant);
  const edgeFields = getLinkElementCandidates(item?.type?.codename || "", elementsMap);
  console.log(`Edge fields for ${item?.type?.codename}:`, edgeFields);

  const links = new Set();
  for (const field of edgeFields) {
    const val = elementsMap[field];
    const extractedIds = extractLinkedIdsFromValue(val);
    console.log(`Field ${field} has ${extractedIds.length} linked items:`, extractedIds);
    for (const id of extractedIds) {
      links.add(id);
    }
  }

  console.log(`Total outgoing links from ${itemId}:`, links.size);
  return { item, variant, links: Array.from(links) };
}

// ---- Meta endpoints for UI ----
app.get("/api/meta/languages", (_req, res) => res.json({ languages: activeLanguages }));
app.get("/api/meta/workflow-steps", (_req, res) => res.json({ steps: workflowStepsForUi }));

// ===== GRAPH TRAVERSAL =====
app.post("/api/graph/query", async (req, res) => {
  try {
    const {
      rootItemIds = [],
      languageCodename,
      layerElementCodename = "layer",  // optional
      layerFilterIn,                   // optional
      typeFilterIn,                    // optional
      maxNodes = 2000
    } = req.body || {};

    console.log("Graph query request:", { rootItemIds, languageCodename, layerElementCodename, layerFilterIn, typeFilterIn, maxNodes });

    if (!Array.isArray(rootItemIds) || !rootItemIds.length) {
      return res.status(400).json({ error: "Provide rootItemIds" });
    }
    if (!languageCodename) {
      return res.status(400).json({ error: "Provide languageCodename" });
    }

    // make sure schemas are present for best edge detection
    if (typeLinkElementMap.size === 0) {
      console.log("Type schemas not loaded, hydrating...");
      try { await hydrateTypeSchemas(); } catch (e) {
        console.error("Failed to hydrate type schemas:", e);
      }
    }

    const queue = [...rootItemIds];
    const seen = new Set(rootItemIds);
    const results = [];

    console.log(`Starting graph traversal with ${queue.length} root items`);

    while (queue.length && results.length < maxNodes) {
      const id = queue.shift();
      console.log(`Processing item ${id} (queue: ${queue.length}, results: ${results.length})`);
      
      const { item, variant, links } = await getItemBundle(id, languageCodename);
      if (!item) {
        console.log(`Skipping ${id} - no item data`);
        continue;
      }

      const name = item?.name || "";
      const typeCodename = item?.type?.codename || "";
      const elementsMap = readElementsMap(variant);

      // read layer values - since we only have element IDs, we'll check all elements for taxonomy-like values
      console.log(`Looking for layer values in elements...`);
      let layerValues = [];
      
      // Check all elements for taxonomy/option-like structures
      for (const [elementId, rawValue] of Object.entries(elementsMap)) {
        if (!rawValue) continue;
        
        let elementLayerValues = [];
        if (Array.isArray(rawValue)) {
          // Handle array of taxonomies/options
          elementLayerValues = rawValue.map(v => {
            if (typeof v === "string") return v;
            return v?.codename || v?.name || v?.value || String(v);
          }).filter(Boolean);
        } else if (typeof rawValue === "object" && rawValue !== null) {
          // Handle single taxonomy/option object
          const val = rawValue.codename || rawValue.name || rawValue.value;
          if (val) elementLayerValues = [String(val)];
        } else if (typeof rawValue === "string") {
          // Handle direct string value
          elementLayerValues = [rawValue];
        }
        
        if (elementLayerValues.length > 0) {
          console.log(`Found layer values in element ${elementId}:`, elementLayerValues);
          // Use the first non-empty element we find, or combine them
          if (layerValues.length === 0) {
            layerValues = elementLayerValues;
          }
        }
      }
      
      console.log(`Final layer values:`, layerValues);

      console.log(`Item ${id}: name="${name}", type="${typeCodename}", layers=[${layerValues.join(',')}], links=${links.length}`);

      // add row
      results.push({
        id: item.id,
        name,
        typeCodename,
        layerValues,
        linkedCount: links.length
      });

      // enqueue children
      for (const childId of links) {
        if (!seen.has(childId) && results.length + queue.length < maxNodes) {
          seen.add(childId);
          queue.push(childId);
          console.log(`Enqueued child ${childId}`);
        }
      }
    }

    console.log(`Graph traversal complete: ${results.length} items processed`);

    // optional filters
    const layerSet = new Set((Array.isArray(layerFilterIn) ? layerFilterIn : String(layerFilterIn || "").split(/[\s,]+/)).filter(Boolean).map(x => x.toLowerCase()));
    const typeSet  = new Set((Array.isArray(typeFilterIn)  ? typeFilterIn  : String(typeFilterIn  || "").split(/[\s,]+/)).filter(Boolean).map(x => x.toLowerCase()));

    let out = results;
    if (layerSet.size) {
      console.log(`Filtering by layers: ${Array.from(layerSet)}`);
      out = out.filter(r => (r.layerValues || []).some(v => layerSet.has(String(v).toLowerCase())));
      console.log(`After layer filter: ${out.length} items`);
    }
    if (typeSet.size) {
      console.log(`Filtering by types: ${Array.from(typeSet)}`);
      out = out.filter(r => typeSet.has(String(r.typeCodename).toLowerCase()));
      console.log(`After type filter: ${out.length} items`);
    }

    res.json({ count: out.length, items: out });
  } catch (e) {
    console.error("Error in graph query:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// GET /api/item/:id?lang=en_GB
// -> { item, variant, links:[childIds...] }
app.get("/api/item/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const languageCodename = req.query.lang || "English";
    console.log(`API request for item ${id} in ${languageCodename}`);
    const bundle = await getItemBundle(id, languageCodename);
    res.json(bundle);
  } catch (e) {
    console.error("Error in /api/item:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---- Actions ----
app.post("/api/workflow", async (req, res) => {
  const { itemIds, languageCodenames, workflowStepId, dryRun } = req.body;

  const ids = splitIds(itemIds);
  const langs = Array.isArray(languageCodenames) ? languageCodenames.filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: "No item IDs provided" });
  if (!langs.length) return res.status(400).json({ error: "No language codenames provided" });
  if (!workflowStepId) return res.status(400).json({ error: "No workflow step ID" });

  const target = workflowStepsForUi.find(s => s.id === workflowStepId);
  if (!target) return res.status(400).json({ error: "Invalid workflow step ID" });

  if (stepToWorkflow.size === 0) {
    try { await hydrateWorkflows(); } catch { /* ignore; we'll fail below if needed */ }
  }
  const wfId = stepToWorkflow.get(workflowStepId);
  if (!wfId && !target.published && !target.archived) {
    return res.status(400).json({ error: `Cannot resolve workflow for step ${workflowStepId}` });
  }

  const results = [];

  for (const id of ids) {
    for (const lang of langs) {
      try {
        if (dryRun) { results.push({ id, lang, status: "DRY_RUN" }); continue; }

        // Published target -> use publish endpoint
        if (target.published) {
          await backoff(() =>
            client.publishLanguageVariant()
              .byItemId(id)
              .byLanguageCodename(lang)
              .withData({})
              .toPromise()
          );
          results.push({ id, lang, status: "PUBLISHED" });
          continue;
        }

        // Archived target -> use unpublish endpoint
        if (target.archived) {
          await backoff(() =>
            client.unpublishLanguageVariant()
              .byItemId(id)
              .byLanguageCodename(lang)
              .withData({})
              .toPromise()
          );
          results.push({ id, lang, status: "UNPUBLISHED" });
          continue;
        }

        // Normal step: try once; if blocked by Publish guard, create new version and retry once
        const doMove = () =>
          client.changeWorkflowOfLanguageVariant()
            .byItemId(id)
            .byLanguageCodename(lang)
            .withData({
              workflow_identifier: { id: wfId },
              step_identifier: { id: workflowStepId }
            })
            .toPromise();

        try {
          await backoff(doMove);
          results.push({ id, lang, status: "MOVED", step: target.codename || target.name, newVersionCreated: false });
        } catch (errFirst) {
          if (!isPublishGuardError(errFirst)) throw errFirst;

          await createNewVersion(id, lang);
          await backoff(doMove);
          results.push({ id, lang, status: "MOVED", step: target.codename || target.name, newVersionCreated: true });
        }
      } catch (e) {
        const apiMsg = e?.originalError?.response?.data?.message
          || e?.response?.data?.message
          || e?.message
          || String(e);
        const validation = e?.originalError?.response?.data?.validation_errors
          || e?.response?.data?.validation_errors;
        results.push({ id, lang, status: "ERROR", message: apiMsg, validation_errors: validation });
      }
    }
  }

  res.json({ action: "workflow", results });
});

app.post("/api/delete", async (req, res) => {
  const { itemIds, deleteMode, languageCodenames, dryRun } = req.body;
  const ids = splitIds(itemIds);
  if (!ids.length) return res.status(400).json({ error: "No item IDs" });
  if (!["item", "variant"].includes(deleteMode)) {
    return res.status(400).json({ error: "deleteMode must be 'item' or 'variant'" });
  }

  const results = [];

  if (deleteMode === "item") {
    for (const id of ids) {
      try {
        if (dryRun) { results.push({ id, status: "DRY_RUN_ITEM" }); continue; }
        await backoff(() => client.deleteContentItem().byItemId(id).toPromise());
        results.push({ id, status: "DELETED_ITEM" });
      } catch (e) {
        results.push({ id, status: "ERROR", message: e.message });
      }
    }
  } else {
    const langs = Array.isArray(languageCodenames) ? languageCodenames.filter(Boolean) : [];
    if (!langs.length) return res.status(400).json({ error: "No languages for variant delete" });

    for (const id of ids) {
      for (const lang of langs) {
        try {
          if (dryRun) { results.push({ id, lang, status: "DRY_RUN_VARIANT" }); continue; }
          await backoff(() =>
            client.deleteLanguageVariant().byItemId(id).byLanguageCodename(lang).toPromise()
          );
          results.push({ id, lang, status: "DELETED_VARIANT" });
        } catch (e) {
          results.push({ id, lang, status: "ERROR", message: e.message });
        }
      }
    }
  }

  res.json({ action: "delete", mode: deleteMode, results });
});

// ---- Boot ----
const PORT = process.env.PORT || 3000;
Promise.allSettled([hydrateWorkflows(), hydrateTypeSchemas()]).finally(() => {
  app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
});