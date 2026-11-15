// Imported by the build (scripts/build.mjs, splitStrings) into every module outside the start that uses strings the
// start does not have: the module runs only once the rest of the current language's strings is here, so no screen
// ever shows a key. (In the source nothing imports it: the tables are whole.)
import { loadRest } from './index';
await loadRest();
