// Files extras, a part of tests/filesextras.cjs: the Full check and Compare. Run: NODE_PATH=$(npm root -g) node tests/filesextras-check.cjs [en|ar]
const a = process.argv; if (a[2] !== 'en' && a[2] !== 'ar') a.splice(2, 0, 'both'); a.push('verify', 'compare');
require('./filesextras.cjs');
