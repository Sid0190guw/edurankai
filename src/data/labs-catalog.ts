// Licensable virtual-lab catalog — the source of truth for the labs API
// (/api/labs/catalog.json) and the partner licensing page (/labs). Each lab is
// a self-contained, offline-capable, embeddable module (iframe or SDK) that an
// institution can drop into its own LMS / virtual infrastructure.
export interface LabEntry {
  slug: string;
  title: string;
  category: string;
  blurb: string;         // one line, market-facing
  flagship?: boolean;    // deep, instrument-grade modules
}

export const LABS: LabEntry[] = [
  // Flagship, instrument-grade
  { slug: 'quantum-lab', title: 'Quantum Lab', category: 'Quantum Computing', flagship: true, blurb: 'Full statevector quantum-circuit simulator: build circuits, Bloch spheres, entanglement, measurement, Bell/GHZ/Grover.' },
  { slug: 'nn-playground', title: 'Neural Network Playground', category: 'AI / ML', flagship: true, blurb: 'Train a real MLP live — hand-written backpropagation, decision boundary, per-neuron activations, loss curves.' },
  { slug: 'exploit-sandbox', title: 'Exploit Sandbox', category: 'Cybersecurity', flagship: true, blurb: 'A real stack buffer-overflow range: ret2win control-flow hijack; defeat stack canaries, NX and ASLR.' },
  { slug: 'mcu-emulator', title: 'MCU Emulator', category: 'Embedded Systems', flagship: true, blurb: 'Program an 8-bit microcontroller in assembly with memory-mapped GPIO — write code, drive real LEDs and buttons.' },
  { slug: 'cad-studio', title: 'CAD Studio', category: 'Aerospace / CAD', flagship: true, blurb: 'Parametric solid modeler with true BSP-CSG booleans, a constrained sketcher, mass properties and orthographic drawings.' },
  { slug: 'cad-assembly', title: 'CAD Assembly', category: 'Aerospace / CAD', flagship: true, blurb: 'Multi-part assemblies with a real interference check (AABB + Monte-Carlo clash volume) and mass roll-up.' },
  { slug: 'cad-fea', title: 'CAD FEA', category: 'Aerospace / CAD', flagship: true, blurb: 'Real 2-D plane-stress finite-element analysis: von Mises field, deflection, yield safety factor, stress concentration.' },
  { slug: 'flight-sim', title: 'Flight Simulator', category: 'Aerospace / CAD', flagship: true, blurb: 'Real-time 3D flight with a four-forces model, bank-turn physics, stall dynamics and a landing challenge.' },
  { slug: 'vesper-bench', title: 'VESPER Test Bench', category: 'Aerospace / CAD', flagship: true, blurb: 'Three-tier spacecraft verification: hover/link budgets, RK4 ascent-to-orbit, interplanetary delta-v — pass/fail campaigns.' },

  // Full vlabs-style workbenches (aim / theory / procedure / simulation / assessment)
  { slug: 'vlsi', title: 'VLSI & Digital Design', category: 'Electronics', blurb: 'Gate logic, Quine-McCluskey, FSMs, static timing, CMOS delay/sizing, power. 11 experiments.' },
  { slug: 'eee', title: 'Electrical & Electronics', category: 'Electronics', blurb: 'Nodal analysis, transient scope, Bode, pole-zero, root-locus, BJT/MOSFET curves. 11 experiments.' },
  { slug: 'cybersecurity', title: 'Cybersecurity', category: 'Cybersecurity', blurb: 'Ciphers, RSA, Diffie-Hellman, SHA-256, AES internals, ECC, overflow visualiser. 11 experiments.' },
  { slug: 'ai-ml', title: 'AI & Machine Learning', category: 'AI / ML', blurb: 'Regression, k-means, k-NN, backprop, CNN feature maps, k-fold CV, Iris classifier. 11 experiments.' },
  { slug: 'robotics', title: 'Robotics & AI', category: 'Robotics', blurb: 'Arm FK/IK, A*, PID, Jacobian IK, RRT* planning, EKF-SLAM. 11 experiments.' },
  { slug: 'mechanical', title: 'Mechanical Engineering', category: 'Mechanical', blurb: 'Beams, stress-strain, gears, thermo cycles, 2D FEA, Euler buckling, fatigue. 11 experiments.' },
  { slug: 'fluid-bench', title: 'Fluid Mechanics', category: 'Mechanical', blurb: 'Bernoulli, Reynolds, Darcy-Weisbach + Moody chart, venturi/orifice, Torricelli. 6 experiments.' },
  { slug: 'reaction-bench', title: 'Chemical Reaction Engineering', category: 'Chemical', blurb: 'Batch/CSTR/PFR reactors (RK4), Levenspiel plots, Arrhenius fit, reaction order. 6 experiments.' },
  { slug: 'biotech-bench', title: 'Molecular Biology', category: 'Biology', blurb: 'PCR thermal cycler, gel electrophoresis, restriction digest, Michaelis-Menten, Beer-Lambert. 6 experiments.' },
  { slug: 'dsa-bench', title: 'Data Structures & Algorithms', category: 'Computer Science', blurb: 'Animated BST/AVL, heaps, hash tables, stacks/queues, BFS/DFS. 7 experiments.' },
];

export const LAB_CATEGORIES = Array.from(new Set(LABS.map((l) => l.category)));
