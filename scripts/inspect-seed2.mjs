import fs from 'fs';

const p1 = JSON.parse(fs.readFileSync('scripts/seed-data/roles-part-1.json', 'utf8'));
const p2 = JSON.parse(fs.readFileSync('scripts/seed-data/roles-part-2.json', 'utf8'));

const allDepts = [...p1, ...p2];

console.log('=== Departments in seed files ===');
let totalRoles = 0;
const allLevels = new Set();
const allRoles = [];

for (const dept of allDepts) {
  const roleCount = Array.isArray(dept.roles) ? dept.roles.length : 0;
  totalRoles += roleCount;
  console.log(`  ${dept.id} (${dept.dbId}) - ${dept.name} - ${roleCount} roles`);
  if (Array.isArray(dept.roles)) {
    for (const r of dept.roles) {
      if (r.level) allLevels.add(r.level);
      allRoles.push({
        deptId: dept.id,
        deptDbId: dept.dbId,
        title: r.title,
        level: r.level
      });
    }
  }
}

console.log('');
console.log('Total roles across all departments:', totalRoles);
console.log('');
console.log('=== Levels used ===');
console.log([...allLevels].sort().join(', '));

console.log('');
console.log('=== Sample of role titles ===');
allRoles.slice(0, 20).forEach(r => console.log(`  [${r.deptId}/${r.level}] ${r.title}`));
if (allRoles.length > 20) console.log(`  ... and ${allRoles.length - 20} more`);

console.log('');
console.log('=== Full first role (all fields) ===');
const firstDept = allDepts[0];
if (firstDept && Array.isArray(firstDept.roles) && firstDept.roles.length > 0) {
  console.log(JSON.stringify(firstDept.roles[0], null, 2));
}
