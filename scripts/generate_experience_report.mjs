import path from 'node:path';
import {writeReport} from '../audit.mjs';
console.log(JSON.stringify(writeReport(path.resolve(process.argv[2]||process.cwd()),process.argv[3]).totals));
