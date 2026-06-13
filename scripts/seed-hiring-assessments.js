'use strict';
/**
 * scripts/seed-hiring-assessments.js
 *
 * Seeds two hiring assessment tracks:
 *   1. Maintenance Technician Hiring Assessment  (20 Qs, 70% passing)
 *   2. Maintenance Supervisor Hiring Assessment  (20 Qs, 75% passing)
 *
 * Run: node scripts/seed-hiring-assessments.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── TECH TRACK ───────────────────────────────────────────────────────────────
const TECH_TRACK = {
  name: 'Maintenance Technician Assessment',
  slug: 'tech-hiring-assessment',
  description: 'Hands-on skills screening for maintenance technician candidates. Covers electrical, HVAC, plumbing, appliances, and safety.',
  icon: '🔧',
  difficulty_level: 'intermediate',
  estimated_hours: 1,
};

const TECH_MODULE = {
  name: 'Technician Skills & Safety',
  description: 'Core competencies for maintenance technicians.',
  order_index: 1,
};

const TECH_QUIZ = {
  title: 'Maintenance Technician Hiring Assessment',
  passing_score: 70,
  time_limit_minutes: 25,
};

const TECH_QUESTIONS = [
  {
    question_text: 'A tenant reports no power in two adjacent bedrooms but other rooms are fine. What is the MOST likely cause?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [{ label: 'Tripped GFCI outlet', value: 'A' }, { label: 'Tripped circuit breaker', value: 'B' }, { label: 'Failed main breaker', value: 'C' }, { label: 'Loose neutral at panel', value: 'D' }],
    correct_answer: 'B',
    explanation: 'Two adjacent bedrooms losing power while others are unaffected is a classic tripped circuit breaker. A GFCI would only affect its own circuit; a main failure would affect everything.',
  },
  {
    question_text: 'Before working on a circuit, you verify it is de-energized with a non-contact voltage tester. The tester shows no voltage. What should you do next?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [{ label: 'Begin work immediately', value: 'A' }, { label: 'Test the tester on a known live source first, then re-test', value: 'B' }, { label: 'Have a coworker confirm visually', value: 'C' }, { label: 'Call the utility company', value: 'D' }],
    correct_answer: 'B',
    explanation: 'Always test your tester on a known live source before and after testing. A dead battery or failed tester could give a false "safe" reading.',
  },
  {
    question_text: 'A GFCI outlet keeps tripping immediately when reset. What is the MOST likely issue?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [{ label: 'The outlet needs to be replaced', value: 'A' }, { label: 'There is a ground fault on the circuit or a downstream load', value: 'B' }, { label: 'The circuit breaker is too small', value: 'C' }, { label: 'The neutral and ground are swapped', value: 'D' }],
    correct_answer: 'B',
    explanation: 'A GFCI that trips immediately on reset is detecting a ground fault — current leaking to ground. Check all loads and outlets downstream before replacing the GFCI.',
  },
  {
    question_text: 'An AC unit is running but not cooling. The outdoor unit is running and you can feel air from the supply vents. What should you check FIRST?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [{ label: 'Refrigerant charge', value: 'A' }, { label: 'Air filter and return air restriction', value: 'B' }, { label: 'Compressor capacitor', value: 'C' }, { label: 'Thermostat calibration', value: 'D' }],
    correct_answer: 'B',
    explanation: 'Always start with the simplest cause. A clogged filter restricts airflow, reduces cooling capacity, and can cause coil freeze-up. Check it before diagnosing refrigerant or electrical issues.',
  },
  {
    question_text: 'You arrive at a unit with a frozen evaporator coil. What is your first step?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [{ label: 'Add refrigerant', value: 'A' }, { label: 'Turn the system to fan-only and let it thaw', value: 'B' }, { label: 'Replace the TXV', value: 'C' }, { label: 'Call a licensed HVAC tech immediately', value: 'D' }],
    correct_answer: 'B',
    explanation: 'A frozen coil must thaw before you can accurately diagnose the root cause (low refrigerant, low airflow, etc.). Switch to fan-only to speed thawing without adding heat load.',
  },
  {
    question_text: 'A tenant complains the heat runs constantly but the apartment is still cold. The air filter is clean. What do you check next?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [{ label: 'Refrigerant level', value: 'A' }, { label: 'Supply and return vent positions, and outdoor temperature vs. heat pump rating', value: 'B' }, { label: 'Circuit breaker', value: 'C' }, { label: 'Compressor oil', value: 'D' }],
    correct_answer: 'B',
    explanation: 'Check vent positions for obstruction and verify the heat pump can operate at the current outdoor temp. Heat pumps lose efficiency in extreme cold and may need auxiliary heat to keep up.',
  },
  {
    question_text: 'A toilet runs continuously. You jiggle the handle and it stops. What is the MOST likely fix?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [{ label: 'Replace the fill valve', value: 'A' }, { label: 'Replace the wax ring', value: 'B' }, { label: 'Adjust or replace the flapper chain — it is likely catching', value: 'C' }, { label: 'Replace the entire flush valve', value: 'D' }],
    correct_answer: 'C',
    explanation: 'When jiggling the handle fixes a running toilet, the flapper chain is usually the culprit — too long and catching under the flapper. Adjust or shorten the chain first.',
  },
  {
    question_text: 'A tenant reports low hot water pressure at the kitchen faucet only. Cold pressure is normal. What do you suspect?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [{ label: 'Water heater failure', value: 'A' }, { label: 'Clogged faucet aerator or partially closed shut-off valve', value: 'B' }, { label: 'Failed pressure reducing valve', value: 'C' }, { label: 'Cross-connected supply lines', value: 'D' }],
    correct_answer: 'B',
    explanation: 'Low hot pressure at one fixture points to a localized restriction — a clogged aerator is the most common cause. Also check the hot shut-off under the sink.',
  },
  {
    question_text: 'You are snaking a slow floor drain and hit resistance at about 15 feet. The snake will not pass. What do you do?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [{ label: 'Force the snake through with more torque', value: 'A' }, { label: 'Pull back, try a different entry point or escalate to jetting', value: 'B' }, { label: 'Pour chemical drain cleaner and leave it', value: 'C' }, { label: 'Replace the drain stack', value: 'D' }],
    correct_answer: 'B',
    explanation: 'Forcing a snake can break it off or damage the pipe. If you hit solid resistance, pull back and try accessing from a cleanout closer to the blockage, or escalate to hydro-jetting.',
  },
  {
    question_text: 'A dishwasher is leaking from the door seal. The tenant says food debris collects there. What is your first action?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [{ label: 'Replace the door gasket immediately', value: 'A' }, { label: 'Clean and inspect the door gasket — debris causes gaps', value: 'B' }, { label: 'Replace the dishwasher', value: 'C' }, { label: 'Adjust the door latch tension', value: 'D' }],
    correct_answer: 'B',
    explanation: 'Before replacing a gasket, clean it thoroughly. Food and grime under the seal cause leaks. If cleaning does not fix it, then replace the gasket.',
  },
  {
    question_text: 'A clothes dryer tumbles but produces no heat. The vent duct is clear. What is the MOST likely cause?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [{ label: 'Blown thermal fuse', value: 'A' }, { label: 'Failed drum belt', value: 'B' }, { label: 'Bad door switch', value: 'C' }, { label: 'Tripped GFCI', value: 'D' }],
    correct_answer: 'A',
    explanation: 'A dryer that runs but does not heat almost always has a blown thermal fuse. This is a safety device that trips when the dryer overheats, often due to a clogged vent.',
  },
  {
    question_text: 'What does LOTO stand for and when is it required?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [{ label: 'Lock Out / Tag Out — required any time working on energized equipment', value: 'A' }, { label: 'Lock Out / Tag Out — required when working on equipment that could release hazardous energy', value: 'B' }, { label: 'Load Out / Turn Off — required when leaving a job site', value: 'C' }, { label: 'Lock Out / Tag Out — only required for 480V and above', value: 'D' }],
    correct_answer: 'B',
    explanation: 'LOTO (Lockout/Tagout) is required whenever working on equipment that could unexpectedly energize or release stored energy (electrical, hydraulic, pneumatic, etc.) — not just electrical.',
  },
  {
    question_text: 'You are asked to replace a light switch in a common area. The breaker is locked out and tagged. A second tech says the circuit is safe and to hurry up. What do you do?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [{ label: 'Trust your coworker and proceed', value: 'A' }, { label: 'Verify zero energy yourself with a voltage tester before touching anything', value: 'B' }, { label: 'Call your supervisor before doing anything', value: 'C' }, { label: 'Remove the tag since the breaker is off', value: 'D' }],
    correct_answer: 'B',
    explanation: 'Never rely on someone else\'s word for electrical safety. Always verify zero energy yourself. Each worker should apply their own lock if required.',
  },
  {
    question_text: 'A tenant reports a burning smell near an outlet. What is your FIRST action?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [{ label: 'Remove the outlet cover and inspect the wiring', value: 'A' }, { label: 'Turn off the circuit breaker for that area immediately and do not use the outlet', value: 'B' }, { label: 'Spray water to cool the area', value: 'C' }, { label: 'Tell the tenant to stop using that outlet and note it for next week', value: 'D' }],
    correct_answer: 'B',
    explanation: 'A burning smell at an outlet is a fire risk. Cut power to that circuit immediately. Do not use the outlet. Inspect only after the circuit is confirmed de-energized.',
  },
  {
    question_text: 'What is the correct caulk type for sealing around a bathtub surround?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [{ label: 'Painter\'s latex caulk', value: 'A' }, { label: '100% silicone or siliconized tub & tile caulk', value: 'B' }, { label: 'Grout', value: 'C' }, { label: 'Exterior polyurethane caulk', value: 'D' }],
    correct_answer: 'B',
    explanation: '100% silicone or siliconized tub & tile caulk is required for wet areas. Painter\'s caulk is not waterproof enough and will fail quickly in a bathroom.',
  },
  {
    question_text: 'A door drags on the floor on the latch side. What is the MOST likely cause?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [{ label: 'The door is the wrong size', value: 'A' }, { label: 'Loose hinge screws or a sagging hinge', value: 'B' }, { label: 'The floor has settled', value: 'C' }, { label: 'The door needs to be planed', value: 'D' }],
    correct_answer: 'B',
    explanation: 'A door dragging on the latch side almost always means loose or failing hinges. Tighten the screws first — use longer screws if the hole is stripped. Planing is a last resort.',
  },
  {
    question_text: 'You complete a repair and have leftover materials (partial paint can, extra caulk, unused hardware). What do you do?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [{ label: 'Leave them in the unit for the tenant', value: 'A' }, { label: 'Return them to the maintenance shop and log them', value: 'B' }, { label: 'Throw them away to keep the van clean', value: 'C' }, { label: 'Take them home for personal use', value: 'D' }],
    correct_answer: 'B',
    explanation: 'All materials belong to the property. Return unused supplies to the shop and log them for inventory tracking. Never take materials home or abandon them in a unit.',
  },
  {
    question_text: 'A work order says a smoke detector is chirping. You replace the battery and it still chirps. What do you do?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [{ label: 'Leave it — the battery just needs to stabilize', value: 'A' }, { label: 'Test and replace the smoke detector unit if chirping continues after battery replacement', value: 'B' }, { label: 'Remove the detector and note it as a tenant issue', value: 'C' }, { label: 'Disconnect the unit and order a new one for next month', value: 'D' }],
    correct_answer: 'B',
    explanation: 'A smoke detector that chirps after a fresh battery is typically at end of life (7-10 years). Replace the entire unit. Never leave a unit without a functioning smoke detector.',
  },
  {
    question_text: 'You are making a repair in an occupied unit and the tenant becomes hostile and blocks you from leaving. What do you do?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [{ label: 'Push past them and leave', value: 'A' }, { label: 'Stay calm, do not escalate, call your supervisor or 911 if you feel unsafe', value: 'B' }, { label: 'Argue until they calm down', value: 'C' }, { label: 'Complete the work and document it later', value: 'D' }],
    correct_answer: 'B',
    explanation: 'De-escalate. Never use physical force. Call your supervisor immediately and call 911 if you feel threatened. Your safety comes first — no repair is worth a confrontation.',
  },
  {
    question_text: 'What is the purpose of a P-trap under a sink?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [{ label: 'To filter debris from the drain', value: 'A' }, { label: 'To hold water that blocks sewer gases from entering the unit', value: 'B' }, { label: 'To regulate water pressure', value: 'C' }, { label: 'To allow clean-out access', value: 'D' }],
    correct_answer: 'B',
    explanation: 'The P-trap holds a water seal that blocks sewer gases (including hydrogen sulfide and methane) from entering the living space. A dry P-trap is a health hazard.',
  },
];

// ─── SUPERVISOR TRACK ────────────────────────────────────────────────────────
const SUP_TRACK = {
  name: 'Maintenance Supervisor Assessment',
  slug: 'supervisor-hiring-assessment',
  description: 'Operational and leadership screening for maintenance supervisor candidates. Covers work order management, compliance, vendor oversight, budgeting, and team leadership.',
  icon: '📋',
  difficulty_level: 'advanced',
  estimated_hours: 1,
};

const SUP_MODULE = {
  name: 'Supervisory Operations & Leadership',
  description: 'Management and compliance competencies for maintenance supervisors.',
  order_index: 1,
};

const SUP_QUIZ = {
  title: 'Maintenance Supervisor Hiring Assessment',
  passing_score: 75,
  time_limit_minutes: 30,
};

const SUP_QUESTIONS = [
  {
    question_text: 'You have 14 open work orders on a Monday morning. Three are emergency water leaks, four are HVAC complaints in summer, and seven are cosmetic issues. How do you prioritize?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [
      { label: 'Oldest work orders first — first in, first out', value: 'A' },
      { label: 'Water leaks first, then HVAC, then cosmetic', value: 'B' },
      { label: 'Cosmetic first — they are quickest to close', value: 'C' },
      { label: 'Assign everything evenly to all techs', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'Life safety and property damage come first. Active water leaks cause mold and structural damage quickly. HVAC in summer is a habitability issue. Cosmetic issues are last.',
  },
  {
    question_text: 'A tenant submits an emergency work order at 2am claiming no heat and the temperature is 38°F outside. Your on-call tech says he cannot make it. What do you do?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [
      { label: 'Schedule for first thing in the morning', value: 'A' },
      { label: 'Contact your backup resource, deliver space heaters if needed, and ensure response tonight', value: 'B' },
      { label: 'Tell the tenant to call the utility company', value: 'C' },
      { label: 'Document it and escalate to the property manager in the morning', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'No heat in freezing temperatures is a habitability emergency. Most jurisdictions require response. Use backup resources, provide temporary heat, and ensure it is handled tonight — not tomorrow.',
  },
  {
    question_text: 'A vendor submits a bill for $4,200 for a repair you did not authorize. What is your first step?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [
      { label: 'Approve it — the work was done', value: 'A' },
      { label: 'Do not pay — contact the vendor to dispute and review what work was actually performed and authorized', value: 'B' },
      { label: 'Split the difference and pay half', value: 'C' },
      { label: 'Escalate to the owner immediately', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'Never approve an unauthorized invoice without a dispute. Contact the vendor, verify the scope of work, compare to your records, and escalate to ownership per your approval threshold policy.',
  },
  {
    question_text: 'One of your techs consistently completes work orders quickly but receives callbacks on 30% of his jobs. How do you address this?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [
      { label: 'Praise his speed — callbacks are expected', value: 'A' },
      { label: 'Have a direct performance conversation, review his callbacks together, and set a quality standard with a follow-up timeline', value: 'B' },
      { label: 'Reassign him to simpler tasks only', value: 'C' },
      { label: 'Document for termination immediately', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'A 30% callback rate is a quality problem regardless of speed. Address it directly and constructively — set clear expectations, review the callbacks together, and give a timeline to improve before escalating.',
  },
  {
    question_text: 'A new tech tells you he does not know how to properly repair a gas appliance but the work order was assigned to him. What do you do?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [
      { label: 'Tell him to figure it out — he needs to learn', value: 'A' },
      { label: 'Reassign the work order to a qualified tech or go with him to supervise and train', value: 'B' },
      { label: 'Have him watch a YouTube video first', value: 'C' },
      { label: 'Close the work order and note it as tenant-caused', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'Gas work requires qualified personnel. Never pressure an unqualified tech to work on gas. Reassign or accompany. This is a safety and liability issue — not a training moment for solo work.',
  },
  {
    question_text: 'During a make-ready inspection you find mold behind the bathroom vanity. The unit is scheduled to turn over in 3 days. What do you do?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [
      { label: 'Paint over it and note it for next turn', value: 'A' },
      { label: 'Bleach the area and dry it, then repaint', value: 'B' },
      { label: 'Assess the extent, remediate properly, fix the moisture source, and adjust the move-in date if necessary', value: 'C' },
      { label: 'Move the tenant in and fix it after they settle', value: 'D' },
    ],
    correct_answer: 'C',
    explanation: 'Mold requires proper remediation — not just surface treatment. You must also fix the moisture source or it returns. Moving in a tenant before remediation is complete is a habitability and legal liability.',
  },
  {
    question_text: 'Your monthly maintenance budget is $8,500. You are at $7,900 on the 20th. A major HVAC repair comes in at $2,200. What do you do?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [
      { label: 'Delay the repair until next month', value: 'A' },
      { label: 'Approve and complete the repair, notify ownership of the overage and your reasoning', value: 'B' },
      { label: 'Patch it temporarily and submit a budget variance request', value: 'C' },
      { label: 'Split the invoice across two months', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'A necessary HVAC repair cannot wait. Complete the work, document the reason for the overage, and communicate proactively to ownership. Most owners expect occasional variances for genuine emergencies.',
  },
  {
    question_text: 'What is the purpose of a make-ready checklist?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [
      { label: 'To estimate the cost of repairs', value: 'A' },
      { label: 'To ensure every unit is inspected and restored to a consistent standard before move-in', value: 'B' },
      { label: 'To document tenant damage for billing', value: 'C' },
      { label: 'To satisfy insurance requirements', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'A make-ready checklist ensures consistent unit quality across every turn. It protects the property, sets expectations for techs, and reduces liability from missed items.',
  },
  {
    question_text: 'A tenant complains about a repair tech\'s behavior in their unit — they say he was rude and left a mess. How do you respond?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [
      { label: 'Defend your tech without investigating', value: 'A' },
      { label: 'Apologize to the tenant, investigate with the tech, and follow up with the tenant on the outcome', value: 'B' },
      { label: 'Tell the tenant to put their complaint in writing', value: 'C' },
      { label: 'Reassign future work orders for that unit to a different tech', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'Acknowledge the concern, investigate fairly, and close the loop with the tenant. Never dismiss tenant feedback without looking into it, and never throw your tech under the bus without facts.',
  },
  {
    question_text: 'Your property uses a work order management system. A tech tells you he prefers to track jobs in his personal notebook. What is the problem with this?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [
      { label: 'No problem — whatever helps him work faster', value: 'A' },
      { label: 'Personal notebooks do not sync with the team, create liability gaps, and make accountability impossible', value: 'B' },
      { label: 'Notebooks wear out faster than digital tools', value: 'C' },
      { label: 'Management might see his notes', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'Work orders in the system create accountability, enable reporting, track response times, and protect the property in disputes. A personal notebook creates information silos and liability blind spots.',
  },
  {
    question_text: 'Under what circumstances can a maintenance tech enter an occupied unit without prior notice?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [
      { label: 'Any time — maintenance has a master key', value: 'A' },
      { label: 'Only in a genuine emergency threatening life or property', value: 'B' },
      { label: 'When the tenant has not responded to a 24-hour notice', value: 'C' },
      { label: 'When approved by the property manager', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'Tenants have a right to quiet enjoyment. Entry without notice is only permissible in a true emergency (fire, active water leak flooding the unit, suspected medical emergency). All other entries require proper notice per state law.',
  },
  {
    question_text: 'You notice one of your techs arrives 15-20 minutes late almost every day but never misses work. How do you handle this?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [
      { label: 'Ignore it — he always shows up eventually', value: 'A' },
      { label: 'Have a private conversation, document it, and establish a clear expectation with a correction timeline', value: 'B' },
      { label: 'Dock his pay informally', value: 'C' },
      { label: 'Publicly address it in the next team meeting', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'Address attendance issues privately, document the conversation, and set a clear expectation. Public correction damages morale. Ignoring it is unfair to techs who arrive on time.',
  },
  {
    question_text: 'A licensed HVAC contractor tells you the system needs $6,000 in repairs but a full replacement is $9,500 and the unit is 14 years old. What do you recommend to ownership?',
    question_type: 'multiple_choice',
    difficulty: 'advanced',
    options: [
      { label: 'Always repair — it is cheaper today', value: 'A' },
      { label: 'Present both options with the system age and likely lifespan of the repair, then let ownership decide with full information', value: 'B' },
      { label: 'Always replace — newer equipment is always better', value: 'C' },
      { label: 'Get a second opinion and delay the decision', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'A 14-year-old system is near end of life. A $6,000 repair may fail again within 2 years. Present the full picture — repair cost, expected lifespan, replacement cost, energy savings — and let the owner decide. That is your job as supervisor.',
  },
  {
    question_text: 'You have two techs — one experienced and reliable, one newer and still learning. How do you assign a complex boiler repair?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [
      { label: 'Assign it to the newer tech — they need the experience', value: 'A' },
      { label: 'Assign the experienced tech to lead with the newer tech assisting as a training opportunity', value: 'B' },
      { label: 'Send the newer tech alone to save the senior tech for easier work', value: 'C' },
      { label: 'Hire a contractor instead', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'Pair the experienced tech to lead with the newer tech shadowing. Complex repairs require competency; this also creates a training moment without sacrificing quality or safety.',
  },
  {
    question_text: 'An owner asks you to defer all non-emergency work orders for 30 days to cut costs. What is the risk you should communicate?',
    question_type: 'multiple_choice',
    difficulty: 'advanced',
    options: [
      { label: 'None — deferred maintenance is standard practice', value: 'A' },
      { label: 'Deferred maintenance increases long-term repair costs, can create habitability complaints, and may violate lease obligations', value: 'B' },
      { label: 'Tenants will not notice for 30 days', value: 'C' },
      { label: 'Only defer cosmetic work — never structural', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'Deferred maintenance compounds quickly. Small issues become big ones, tenant satisfaction drops, and the property may fall below habitability standards required by law. Always communicate these risks clearly.',
  },
  {
    question_text: 'What is the proper way to document a completed work order?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [
      { label: 'Mark it complete in the system when you arrive at the unit', value: 'A' },
      { label: 'Note what was found, what was done, materials used, time spent, and close it after confirming resolution', value: 'B' },
      { label: 'Close it when the tenant says thank you', value: 'C' },
      { label: 'Let the office close it at the end of the day', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'Proper work order documentation includes findings, actions taken, materials, and time. This protects the property legally, helps track patterns, and ensures accountability for callbacks.',
  },
  {
    question_text: 'A tenant calls you directly on your personal cell to request a repair. What is the correct response?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [
      { label: 'Handle it off the books to save time', value: 'A' },
      { label: 'Listen, but direct them to submit through the official work order channel so it is properly tracked', value: 'B' },
      { label: 'Give them your personal email for faster response', value: 'C' },
      { label: 'Ignore calls from tenants on personal lines', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'Always direct requests through the official channel so they are tracked, prioritized, and documented. Handling repairs off the books creates accountability gaps and liability exposure.',
  },
  {
    question_text: 'It is 4pm Friday. A tech finishes his last work order and asks if he can leave early since the property is quiet. What do you consider?',
    question_type: 'multiple_choice',
    difficulty: 'beginner',
    options: [
      { label: 'Let him leave — reward efficiency', value: 'A' },
      { label: 'Confirm all work orders are closed, there is on-call coverage, and policy allows it before approving', value: 'B' },
      { label: 'Never allow early departure — it sets a bad precedent', value: 'C' },
      { label: 'Let him leave if he promises to answer his phone', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'Reward efficiency but verify first: all WOs closed, on-call covered, nothing pending, and it is within your leave approval authority. Blanket "yes" or "never" are both poor management.',
  },
  {
    question_text: 'What is the most important reason to track recurring maintenance issues by unit or building?',
    question_type: 'multiple_choice',
    difficulty: 'intermediate',
    options: [
      { label: 'To bill tenants for repeat issues', value: 'A' },
      { label: 'To identify systemic problems and make a capital improvement case to ownership before they become emergencies', value: 'B' },
      { label: 'To warn future tenants about problem units', value: 'C' },
      { label: 'To track tech performance', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'Tracking recurring issues reveals systemic problems — aging plumbing, poor drainage design, failing equipment. This data helps you make proactive capital improvement recommendations before a small issue becomes a costly emergency.',
  },
  {
    question_text: 'A fair housing complaint is filed alleging a tenant received slower maintenance response than others. What is your FIRST step?',
    question_type: 'multiple_choice',
    difficulty: 'advanced',
    options: [
      { label: 'Dismiss it — response times vary based on severity', value: 'A' },
      { label: 'Pull all work order records immediately, notify your property manager and legal counsel, and do not discuss with staff until advised', value: 'B' },
      { label: 'Apologize to the tenant and offer a discount', value: 'C' },
      { label: 'Investigate on your own and send a written response to the tenant', value: 'D' },
    ],
    correct_answer: 'B',
    explanation: 'Fair housing complaints are legal matters. Pull the records, notify management and legal counsel immediately, and do not make any statements or take any action without guidance. Your records are your defense.',
  },
];

// ─── RUNNER ───────────────────────────────────────────────────────────────────
async function run() {
  console.log('🔧 Seeding hiring assessment tracks...\n');

  async function seedTrack(trackData, moduleData, quizData, questions) {
    console.log(`\n── ${trackData.name} ──`);

    // Check if track already exists
    const { data: existing } = await sb
      .from('certification_tracks')
      .select('id')
      .eq('slug', trackData.slug)
      .maybeSingle();

    let trackId;
    if (existing) {
      trackId = existing.id;
      console.log(`  Track exists (${trackId}), skipping insert`);
    } else {
      const { data: track, error: tErr } = await sb
        .from('certification_tracks')
        .insert(trackData)
        .select('id')
        .single();
      if (tErr) throw new Error('Track insert failed: ' + tErr.message);
      trackId = track.id;
      console.log(`  ✅ Track created: ${trackId}`);
    }

    // Module
    const { data: existingMod } = await sb
      .from('certification_modules')
      .select('id')
      .eq('track_id', trackId)
      .maybeSingle();

    let moduleId;
    if (existingMod) {
      moduleId = existingMod.id;
      console.log(`  Module exists (${moduleId}), skipping insert`);
    } else {
      const { data: mod, error: mErr } = await sb
        .from('certification_modules')
        .insert({ ...moduleData, track_id: trackId })
        .select('id')
        .single();
      if (mErr) throw new Error('Module insert failed: ' + mErr.message);
      moduleId = mod.id;
      console.log(`  ✅ Module created: ${moduleId}`);
    }

    // Quiz
    const { data: existingQuiz } = await sb
      .from('certification_quizzes')
      .select('id')
      .eq('module_id', moduleId)
      .maybeSingle();

    let quizId;
    if (existingQuiz) {
      quizId = existingQuiz.id;
      console.log(`  Quiz exists (${quizId}), skipping insert`);
    } else {
      const { data: quiz, error: qErr } = await sb
        .from('certification_quizzes')
        .insert({ ...quizData, module_id: moduleId })
        .select('id')
        .single();
      if (qErr) throw new Error('Quiz insert failed: ' + qErr.message);
      quizId = quiz.id;
      console.log(`  ✅ Quiz created: ${quizId}`);
    }

    // Questions
    const { count: existingQCount } = await sb
      .from('certification_questions')
      .select('id', { count: 'exact', head: true })
      .eq('quiz_id', quizId);

    if (existingQCount > 0) {
      console.log(`  Questions already exist (${existingQCount}), skipping`);
    } else {
      const rows = questions.map((q) => ({ ...q, quiz_id: quizId }));
      const { error: rErr } = await sb.from('certification_questions').insert(rows);
      if (rErr) throw new Error('Questions insert failed: ' + rErr.message);
      console.log(`  ✅ ${questions.length} questions inserted`);
    }

    console.log(`  🔗 Assessment URL: https://maintmentor.ai/assessment/${quizId}`);
    return quizId;
  }

  try {
    const techQuizId = await seedTrack(TECH_TRACK, TECH_MODULE, TECH_QUIZ, TECH_QUESTIONS);
    const supQuizId  = await seedTrack(SUP_TRACK,  SUP_MODULE,  SUP_QUIZ,  SUP_QUESTIONS);

    console.log('\n✅ Done!\n');
    console.log('Assessment links:');
    console.log(`  🔧 Tech:       https://maintmentor.ai/assessment/${techQuizId}`);
    console.log(`  📋 Supervisor: https://maintmentor.ai/assessment/${supQuizId}`);
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  }
}

run();
