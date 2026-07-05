/**
 * Netlify Function: save-note
 * Receives a team note and appends it to the corresponding Notion page.
 *
 * POST /.netlify/functions/save-note
 * Body: { pageId, stateKey, note, displayName }
 */

exports.handler = async (event, context) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON.' }) };
  }

  const { pageId, stateKey, note, displayName } = body;
  if (!pageId || !note?.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'pageId and note are required.' }) };
  }

  const NOTION_TOKEN = process.env.NOTION_API_TOKEN;
  if (!NOTION_TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'NOTION_API_TOKEN not set in Netlify env vars.' }) };
  }

  // Format page ID with dashes (Notion API requires dashed UUID format)
  const raw = pageId.replace(/-/g, '');
  const fmtId = raw.length === 32
    ? `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`
    : pageId;

  const userName = displayName || 'Team Member';
  const dateStr = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
  const noteText = `${userName} · ${dateStr}: ${note.trim()}`;

  try {
    const notionRes = await fetch(`https://api.notion.com/v1/blocks/${fmtId}/children`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        children: [{
          object: 'block',
          type: 'callout',
          callout: {
            rich_text: [{ type: 'text', text: { content: noteText } }],
            icon: { emoji: '📝' },
            color: 'yellow_background'
          }
        }]
      })
    });

    const notionBody = await notionRes.text();
    if (!notionRes.ok) {
      console.error(`Notion ${notionRes.status} for ${stateKey} (${fmtId}):`, notionBody);
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Notion ${notionRes.status}: ${notionBody}` }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, noteText }) };
  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: `Function error: ${err.message || String(err)}` }) };
  }
};
