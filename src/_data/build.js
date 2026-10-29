// Build-time switches. PREVIEW=true makes a private preview: drafts shown,
// search engines told to stay away, comments and analytics off.
export default {
  preview: process.env.PREVIEW === 'true',
  time: new Date().toISOString(),
};
