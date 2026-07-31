/**
 * Netlify Function: save-document
 *
 * Receives a document uploaded from a state's detail panel on the BD Intelligence
 * Map, pushes it to Notion as a real file attachment on that state's page, and
 * appends a marker callout the daily research run can detect.
 *
 * POST /.netlify/functions/save-document
 * Body: {
 *   pageId,        // Notion page id for the state (dashed or undashed)
 *   stateKey,      // e.g. "LA"
 *   fileName,      // original file name
 *   contentType,   // MIME type
 *   fileB64,       // base64-encoded file bytes (no data: prefix)
 *   docType,       // "RFP" | "Addendum" | "Award/Selection" | "Shortlist" | ...
 *   note,          // optional free-text context from the uploader
 *   displayName    // uploader name from Netlify Identity
 * }
 *
 * MARKER CONVENTION — do not change without updating the scheduled task.
 * Team notes use  📝 + yellow_background.
 * Documents use   📎 + blue_background, and the callout text always begins
 * with the literal token "[DOC]" so the daily run can find unprocessed
 * uploads without colliding with the team-note scanner or its dedup hashes.
 */

const NOTION_VERSION = '2022-06-28';
const MAX_BYTES = 5 * 1024 * 1024; // hard server-side ceiling; UI caps lower

const ALLOWED = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'image/png',
  'image/jpeg',
  'text/plain',
]);

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

function dashify(pageId) {
  const raw = String(pageId).replace(/-/g, '');
  return raw.length === 32
    ? `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
    : pageId;
}

// Strip anything that could confuse the marker parser or a filesystem.
function safeName(name) {
  return String(name)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON.' });
  }

  const {
    pageId, stateKey, fileName, contentType,
    fileB64, docType, note, displayName,
  } = body;

  if (!pageId) return json(400, { error: 'pageId is required.' });
  if (!fileB64) return json(400, { error: 'No file content received.' });
  if (!fileName) return json(400, { error: 'fileName is required.' });

  const type = contentType || 'application/octet-stream';
  if (!ALLOWED.has(type)) {
    return json(400, { error: `Unsupported file type: ${type}. Allowed: PDF, Word, Excel, PNG, JPEG, TXT.` });
  }

  let bytes;
  try {
    bytes = Buffer.from(fileB64, 'base64');
  } catch {
    return json(400, { error: 'File content was not valid base64.' });
  }
  if (!bytes.length) return json(400, { error: 'File is empty.' });
  if (bytes.length > MAX_BYTES) {
    return json(413, {
      error: `File is ${(bytes.length / 1048576).toFixed(1)}MB. Limit is ${MAX_BYTES / 1048576}MB — ` +
             `drop larger files straight into the OneDrive research folder instead.`,
    });
  }

  const NOTION_TOKEN = process.env.NOTION_API_TOKEN;
  if (!NOTION_TOKEN) {
    return json(500, { error: 'NOTION_API_TOKEN not set in Netlify env vars.' });
  }

  const authHeaders = {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
  };

  const cleanName = safeName(fileName);
  const fmtId = dashify(pageId);
  const uploader = displayName || 'Team Member';
  const kind = (docType || 'Document').trim();
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, stable for hashing

  try {
    // ── 1. Create the file upload object ────────────────────────────────────
    const createRes = await fetch('https://api.notion.com/v1/file_uploads', {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'single_part',
        filename: cleanName,
        content_type: type,
      }),
    });

    const createText = await createRes.text();
    if (!createRes.ok) {
      console.error('file_uploads create failed:', createRes.status, createText);
      return json(502, { error: `Notion file_uploads ${createRes.status}: ${createText.slice(0, 300)}` });
    }

    const created = JSON.parse(createText);
    const uploadId = created.id;
    const uploadUrl = created.upload_url;
    if (!uploadId || !uploadUrl) {
      return json(502, { error: 'Notion did not return an upload id/url.' });
    }

    // ── 2. Send the bytes ───────────────────────────────────────────────────
    // Let fetch set the multipart boundary — do NOT set Content-Type here.
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), cleanName);

    const sendRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: authHeaders,
      body: form,
    });

    const sendText = await sendRes.text();
    if (!sendRes.ok) {
      console.error('file upload send failed:', sendRes.status, sendText);
      return json(502, { error: `Notion upload ${sendRes.status}: ${sendText.slice(0, 300)}` });
    }

    // ── 3. Attach the file, then the marker callout, to the state page ──────
    // Marker text is parsed by the scheduled task. Keep the shape stable:
    //   [DOC] <kind> | <filename> | uploaded by <name> on <YYYY-MM-DD>[ | <note>]
    let marker = `[DOC] ${kind} | ${cleanName} | uploaded by ${uploader} on ${dateStr}`;
    const trimmedNote = (note || '').trim().replace(/\s+/g, ' ');
    if (trimmedNote) marker += ` | ${trimmedNote.slice(0, 600)}`;

    const children = [
      {
        object: 'block',
        type: 'file',
        file: {
          type: 'file_upload',
          file_upload: { id: uploadId },
          caption: [{ type: 'text', text: { content: `${kind} — uploaded by ${uploader} on ${dateStr}` } }],
        },
      },
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [{ type: 'text', text: { content: marker } }],
          icon: { emoji: '📎' },
          color: 'blue_background',
        },
      },
    ];

    const attachRes = await fetch(`https://api.notion.com/v1/blocks/${fmtId}/children`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ children }),
    });

    const attachText = await attachRes.text();
    if (!attachRes.ok) {
      console.error(`attach failed for ${stateKey} (${fmtId}):`, attachRes.status, attachText);
      return json(502, { error: `Notion attach ${attachRes.status}: ${attachText.slice(0, 300)}` });
    }

    return json(200, {
      success: true,
      fileName: cleanName,
      sizeBytes: bytes.length,
      marker,
      message: `Uploaded to Notion. The next research run (4:45 AM) will review it.`,
    });
  } catch (err) {
    console.error('save-document error:', err);
    return json(500, { error: `Function error: ${err.message || String(err)}` });
  }
};
