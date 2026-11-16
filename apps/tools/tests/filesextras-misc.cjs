// Files extras, a part of tests/filesextras.cjs: Find duplicates and Open in Kurokawa Reader. Run: NODE_PATH=$(npm root -g) node tests/filesextras-misc.cjs [en|ar]
const a = process.argv; if (a[2] !== 'en' && a[2] !== 'ar') a.splice(2, 0, 'both'); a.push('duplicates', 'reader');
require('./filesextras.cjs');
