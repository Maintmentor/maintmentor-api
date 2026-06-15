'use strict';

/**
 * scripts/ingest-manual.js
 *
 * Ingests a PDF maintenance manual into Supabase:
 *   1. Uploads the raw PDF to the 'manuals' storage bucket
 *   2. Extracts text via pdf-parse
 *   3. Chunks the text (~500 words each)
 *   4. Stores metadata in manual_documents table
 *   5. Stores chunks in manual_chunks table (full-text searchable)
 *
 * Usage:
 *   node scripts/ingest-manual.js <path-to-pdf> [title] [category] [manufacturer] [model]
 *
 * Examples:
 *   node scripts/ingest-manual.js ~/manuals/carrier-24acc.pdf "Carrier 24ACC Manual" hvac Carrier 24ACC636A003
 *   node scripts/ingest-manual.js ~/manuals/ao-smith-water-heater.pdf "AO Smith Water Heater" plumbing "AO Smith"
 *
 * Categories: hvac, plumbing, electrical, appliance, general
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs        = require('fs');
const path      = require('path');
const pdfParse  = require('pdf-parse');
const supabase  = require('../lib/supabase');

// ── Config ────────────────────────────────────────────────────────────────
const BUCKET         = 'manuals';
const CHUNK_SIZE     = 500;   // words per chunk
const CHUNK_OVERLAP  = 50;    // word overlap between chunks

// ── Args ─────────────────────────────────────────────────────────────────
const [,, filePath, titleArg, categoryArg, manufacturerArg, modelArg] = process.argv;

if (!filePath) {
  console.error('Usage: node scripts/ingest-manual.js <pdf-path> [title] [category] [manufacturer] [model]');
  process.exit(1);
}

const absPath = path.resolve(filePath);
if (!fs.existsSync(absPath)) {
  console.error('File not found:', absPath);
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Split text into overlapping word chunks
 */
function chunkText(text, chunkWords = CHUNK_SIZE, overlapWords = CHUNK_OVERLAP) {
  // Clean up whitespace
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const words = cleaned.split(/\s+/);
  const chunks = [];
  let i = 0;

  while (i < words.length) {
    const slice = words.slice(i, i + chunkWords);
    chunks.push(slice.join(' '));
    i += chunkWords - overlapWords;
  }

  return chunks;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function ingest() {
  const filename      = path.basename(absPath);
  const title         = titleArg        || filename.replace(/\.pdf$/i, '');
  const category      = categoryArg     || 'general';
  const manufacturer  = manufacturerArg || null;
  const modelNumber   = modelArg        || null;
  const storagePath   = `${category}/${Date.now()}_${filename}`;
  const fileBuffer    = fs.readFileSync(absPath);
  const fileSizeBytes = fileBuffer.length;

  console.log(`\n📄 Ingesting: ${title}`);
  console.log(`   File      : ${filename} (${(fileSizeBytes / 1024).toFixed(1)} KB)`);
  console.log(`   Category  : ${category}`);
  if (manufacturer) console.log(`   Maker     : ${manufacturer}`);
  if (modelNumber)  console.log(`   Model     : ${modelNumber}`);

  // ── 1. Upload PDF to Supabase Storage ──
  console.log('\n⬆️  Uploading to Supabase Storage...');
  const { data: uploadData, error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (uploadErr) {
    console.error('❌ Upload failed:', uploadErr.message);
    process.exit(1);
  }
  console.log('   ✅ Uploaded:', storagePath);

  // ── 2. Extract text ──
  console.log('\n📖 Extracting text from PDF...');
  let pdfData;
  try {
    pdfData = await pdfParse(fileBuffer);
  } catch (e) {
    console.error('❌ PDF parse failed:', e.message);
    process.exit(1);
  }

  const wordCount = pdfData.text.split(/\s+/).length;
  console.log(`   ✅ Extracted ${wordCount.toLocaleString()} words across ${pdfData.numpages} pages`);

  // ── 3. Chunk text ──
  const chunks = chunkText(pdfData.text);
  console.log(`   ✅ Split into ${chunks.length} chunks (~${CHUNK_SIZE} words each)`);

  // ── 4. Insert manual_documents row ──
  console.log('\n💾 Saving to database...');
  const { data: doc, error: docErr } = await supabase
    .from('manual_documents')
    .insert({
      title,
      filename,
      storage_path: storagePath,
      file_size_bytes: fileSizeBytes,
      category,
      manufacturer,
      model_number: modelNumber,
      uploaded_by: 'admin',
    })
    .select('id')
    .single();

  if (docErr) {
    console.error('❌ DB insert failed:', docErr.message);
    // Clean up storage
    await supabase.storage.from(BUCKET).remove([storagePath]);
    process.exit(1);
  }
  console.log(`   ✅ manual_documents row: ${doc.id}`);

  // ── 5. Insert chunks (batch of 50) ──
  const BATCH = 50;
  let inserted = 0;

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH).map((content, j) => ({
      manual_id:   doc.id,
      chunk_index: i + j,
      content,
      page_hint:   null, // future: map via pdf page positions
    }));

    const { error: chunkErr } = await supabase
      .from('manual_chunks')
      .insert(batch);

    if (chunkErr) {
      console.error(`❌ Chunk batch ${i}-${i + BATCH} failed:`, chunkErr.message);
      process.exit(1);
    }

    inserted += batch.length;
    process.stdout.write(`\r   Chunks: ${inserted}/${chunks.length}`);
  }

  console.log(`\n   ✅ ${inserted} chunks stored`);

  // ── 6. Summary ──
  console.log('\n🎉 Done!');
  console.log(`   Document ID : ${doc.id}`);
  console.log(`   Storage     : supabase/manuals/${storagePath}`);
  console.log(`   Chunks      : ${inserted} searchable entries`);
  console.log(`   AI can now answer questions from this manual.\n`);
}

ingest().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
