// Google Drive and Docs access, read-only, through a service account.
import { GoogleAuth } from 'google-auth-library';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
];
const DOC_MIME = 'application/vnd.google-apps.document';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connect(serviceAccountJson) {
  let credentials;
  try {
    credentials = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole key file, including the { and }.');
  }
  const auth = new GoogleAuth({ credentials, scopes: SCOPES });
  const client = await auth.getClient();

  async function get(url) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await client.request({ url });
        return res.data;
      } catch (e) {
        const status = e.response?.status;
        if ((status === 429 || status >= 500) && attempt < 4) { await sleep(1500 * 2 ** attempt); continue; }
        const msg = e.response?.data?.error?.message || e.message;
        const err = new Error(`${status || ''} ${msg}`.trim());
        err.status = status;
        throw err;
      }
    }
  }

  return {
    email: credentials.client_email,
    async token() {
      const t = await client.getAccessToken();
      return t.token || t;
    },

    /** Every Google Doc directly inside the folder, including shortcuts to Docs. */
    async listFolder(folderId) {
      const files = [];
      let pageToken = '';
      do {
        const q = encodeURIComponent(`'${folderId}' in parents and trashed = false and (mimeType = '${DOC_MIME}' or mimeType = '${SHORTCUT_MIME}')`);
        const fields = encodeURIComponent('nextPageToken, files(id, name, mimeType, modifiedTime, shortcutDetails)');
        const data = await get(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`);
        files.push(...(data.files || []));
        pageToken = data.nextPageToken || '';
      } while (pageToken);

      const docs = [];
      for (const f of files) {
        if (f.mimeType === DOC_MIME) docs.push({ id: f.id, name: f.name, modifiedTime: f.modifiedTime });
        else if (f.shortcutDetails?.targetMimeType === DOC_MIME) {
          // A shortcut: the service account needs access to the original too.
          try {
            const t = await get(`https://www.googleapis.com/drive/v3/files/${f.shortcutDetails.targetId}?fields=id,name,modifiedTime&supportsAllDrives=true`);
            docs.push({ id: t.id, name: t.name, modifiedTime: t.modifiedTime, viaShortcut: true });
          } catch (e) {
            docs.push({ id: f.shortcutDetails.targetId, name: f.name, error: `"${f.name}" is a shortcut, and the original Doc isn't shared with the blog. Move the Doc itself into the folder instead of a shortcut.` });
          }
        }
      }
      return docs;
    },

    async getDoc(id) {
      return get(`https://docs.googleapis.com/v1/documents/${id}?includeTabsContent=true`);
    },
  };
}
