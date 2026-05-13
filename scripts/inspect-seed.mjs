import fs from 'fs';

const p1 = JSON.parse(fs.readFileSync('scripts/seed-data/roles-part-1.json', 'utf8'));
const p2 = JSON.parse(fs.readFileSync('scripts/seed-data/roles-part-2.json', 'utf8'));

console.log('=== Part 1 ===');
console.log('Type:', Array.isArray(p1) ? 'Array' : typeof p1);
console.log('Count:', Array.isArray(p1) ? p1.length : Object.keys(p1).length);
if (Array.isArray(p1) && p1.length > 0) {
  console.log('First entry keys:', Object.keys(p1[0]));
  console.log('First role:', JSON.stringify(p1[0], null, 2).substring(0, 800));
}

console.log('');
console.log('=== Part 2 ===');
console.log('Type:', Array.isArray(p2) ? 'Array' : typeof p2);
console.log('Count:', Array.isArray(p2) ? p2.length : Object.keys(p2).length);
if (Array.isArray(p2) && p2.length > 0) {
  console.log('First entry keys:', Object.keys(p2[0]));
}

const all = [...(Array.isArray(p1) ? p1 : []), ...(Array.isArray(p2) ? p2 : [])];
const depts = new Set(all.map(r => r.department_id || r.departmentId).filter(Boolean));
console.log('');
console.log('=== Aggregate ===');
console.log('Total roles in seed files:', all.length);
console.log('Departments referenced:', [...depts].sort().join(', '));

const levels = new Set(all.map(r => r.level).filter(Boolean));
console.log('Levels referenced:', [...levels].sort().join(', '));
