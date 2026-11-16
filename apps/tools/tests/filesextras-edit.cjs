// Files extras, a part of tests/filesextras.cjs: the text editor. Run: NODE_PATH=$(npm root -g) node tests/filesextras-edit.cjs [en|ar]
const a = process.argv; if (a[2] !== 'en' && a[2] !== 'ar') a.splice(2, 0, 'both'); a.push('editor');
require('./filesextras.cjs');
