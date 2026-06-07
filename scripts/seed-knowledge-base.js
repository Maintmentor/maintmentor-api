'use strict';

/**
 * scripts/seed-knowledge-base.js
 *
 * Pre-loads MaintMentor's certification content into `knowledge_embeddings`
 * so the AI launches with Dean's 30 years of maintenance expertise already embedded.
 *
 * Usage:
 *   node scripts/seed-knowledge-base.js
 *   node scripts/seed-knowledge-base.js --force   (re-seed even if >50 rows exist)
 *
 * Flow:
 *   1. Check knowledge_embeddings row count — warn if >50 and --force not set
 *   2. Try to load content from certification_lessons + certification_quiz_questions tables
 *   3. Fall back to hardcoded Q&A pairs if DB tables are empty or missing
 *   4. Embed each Q&A pair via Gemini text-embedding-004 (rate limited: 1 per 100ms)
 *   5. Insert into knowledge_embeddings
 *   6. Save summary to data/seed-summary.json
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const fs   = require('fs');

const { embedText }  = require('../lib/embeddings');
const supabase       = require('../lib/supabase');

// ─── Config ────────────────────────────────────────────────────────────────────

const FORCE_FLAG      = process.argv.includes('--force');
const ROW_WARN_THRESH = 50;     // Warn if DB already has this many rows
const RATE_LIMIT_MS   = 100;    // 1 embedding per 100ms
const DATA_DIR        = path.join(__dirname, '..', 'data');
const SUMMARY_FILE    = path.join(DATA_DIR, 'seed-summary.json');

// ─── Hardcoded Fallback Q&A Content ───────────────────────────────────────────
// 30 high-quality maintenance Q&A pairs covering Dean's 30 years of expertise

const FALLBACK_QA = [
  // ── Electrical ──────────────────────────────────────────────────────────────
  {
    category: 'electrical',
    question: 'How do I reset a GFCI outlet that has tripped?',
    answer: 'Locate the GFCI outlet (usually in bathrooms, kitchens, garages, or outdoors). Press the TEST button first if available, then press the RESET button firmly until you feel/hear a click. If it won\'t reset: (1) Make sure the outlet is not wet or overloaded. (2) Unplug all devices from that outlet and any outlets on the same circuit. (3) Check the electrical panel for a tripped breaker — reset it. (4) Try pressing RESET again. If still not working, the GFCI outlet may be faulty and needs replacement.',
  },
  {
    category: 'electrical',
    question: 'Why does my circuit breaker keep tripping?',
    answer: 'A breaker trips when it detects more current than it can safely handle. Common causes: (1) Overloaded circuit — too many appliances on one circuit. Solution: redistribute loads, add a dedicated circuit. (2) Short circuit — damaged wiring or faulty appliance creating a direct hot-to-neutral path. Unplug all devices, reset breaker, plug in one device at a time to find the culprit. (3) Ground fault — current leaking to ground. Check for damaged cords or wet conditions. (4) Faulty breaker — if breaker trips immediately with nothing plugged in, the breaker itself may need replacement. Safety note: if breaker is warm/hot to touch or smells burnt, call a licensed electrician immediately.',
  },
  {
    category: 'electrical',
    question: 'An outlet stops working but the breaker is not tripped. What should I check?',
    answer: 'If an outlet is dead but the breaker is fine: (1) Look for a GFCI outlet on the same circuit — a tripped GFCI can cut power to multiple outlets downstream. Check bathrooms, kitchen, garage. (2) Check for a switch-controlled outlet — some outlets are wired to a wall switch. (3) Inspect the outlet itself — it may have a loose wire connection inside. Turn off the breaker, remove the outlet cover, and check for loose wires. (4) Look for another GFCI in the circuit: circuit may have multiple GFCI devices. (5) If all else fails, the outlet may be on a separate small circuit with its own breaker that isn\'t labeled.',
  },
  {
    category: 'electrical',
    question: 'What is the proper Lockout/Tagout (LOTO) procedure for electrical maintenance?',
    answer: 'LOTO (Lockout/Tagout) protects workers from unexpected energization. Procedure: (1) NOTIFY — Inform all affected employees. (2) IDENTIFY — Locate all energy sources (electrical, pneumatic, hydraulic, gravity). (3) SHUTDOWN — Turn off the equipment using the normal stopping procedure. (4) ISOLATE — Open the disconnect switch/circuit breaker. (5) LOCKOUT — Apply your personal padlock to the energy isolation device. (6) TAGOUT — Attach a warning tag with name, date, and reason. (7) VERIFY — Use a voltmeter to test that no energy remains — test live, test dead, test live. (8) RELEASE — Remove stored energy (discharge capacitors, bleed pressure, block gravity). Each worker applies their own lock. Never remove another worker\'s lock.',
  },
  {
    category: 'electrical',
    question: 'How do I safely test if a wire is live?',
    answer: 'Never touch a wire to test if it\'s live. Use a non-contact voltage tester (NCVT): hold it near the wire — it beeps and lights up if voltage is present. For confirmation, use a multimeter: set to AC voltage (200V range for US residential), carefully touch red probe to the suspected hot wire and black probe to neutral or ground. Safety: always assume wires are live until proven otherwise. Wear rubber-soled shoes, use insulated tools, keep one hand behind your back or in your pocket (prevents current path across your heart), never work alone on live circuits. For 240V circuits, use a high-voltage rated tester.',
  },

  // ── HVAC ─────────────────────────────────────────────────────────────────────
  {
    category: 'hvac',
    question: 'My air conditioner is running but not cooling. What should I check?',
    answer: 'AC running but not cooling — systematic diagnosis: (1) Check the air filter — a clogged filter restricts airflow and causes freezing. Replace if dirty (every 1-3 months). (2) Check evaporator coil for ice — if frozen, turn AC off, fan only ON for 2-3 hours to thaw. (3) Check condenser unit outside — is the fan spinning? Is it clogged with debris? Clear away grass, leaves, dirt. (4) Check refrigerant — low refrigerant causes poor cooling with ice on lines. Signs: hissing noise, ice on copper lines, unit runs constantly. Requires licensed HVAC tech to check and recharge. (5) Check thermostat wiring and settings. (6) Check condenser coils for dirt — clean with coil cleaner if coated. (7) Verify supply vents are open and not blocked.',
  },
  {
    category: 'hvac',
    question: 'How often should HVAC filters be replaced and what MERV rating should I use?',
    answer: 'Filter replacement frequency: basic 1-inch filters every 30-60 days; pleated 1-inch filters every 60-90 days; 4-inch media filters every 6-12 months. In high-use or dusty environments, replace more frequently. Check monthly — hold up to light, if you can\'t see through it, replace it. MERV ratings: MERV 1-4 (basic fiberglass) — minimum protection, catches large particles; MERV 8-10 (standard pleated) — recommended for residential, catches dust, pollen, mold spores; MERV 11-13 — better filtration, catches pet dander, fine dust, recommended for allergies; MERV 14+ (HEPA-equivalent) — very high restriction, only for systems designed for it — can damage equipment if used improperly. For most residential HVAC: MERV 8-10 is the sweet spot between air quality and system airflow.',
  },
  {
    category: 'hvac',
    question: 'What are the signs of a refrigerant leak in an HVAC system?',
    answer: 'Signs of refrigerant leak: (1) Warm air from vents — system runs but doesn\'t cool properly. (2) Ice on evaporator coil or suction line (copper pipe leading into air handler). (3) Hissing or bubbling sound near the unit — refrigerant escaping under pressure. (4) Higher electric bills — system works harder to compensate. (5) Unit runs constantly without reaching setpoint. (6) Frost or ice on outdoor unit in summer. (7) Oily residue around refrigerant lines — oil travels with refrigerant and marks leaks. Important: refrigerant handling requires EPA 608 certification. Do not attempt to add refrigerant yourself. Call a licensed HVAC technician. Refrigerant leaks are also environmental violations — they must be repaired, not just topped off.',
  },
  {
    category: 'hvac',
    question: 'How do I wire a standard thermostat? What do the wire colors mean?',
    answer: 'Standard thermostat wire colors (5-wire system): R (red) — 24V power from transformer; C (common, blue/black) — completes 24V circuit, powers smart thermostats; Y (yellow) — cooling/AC contactor; G (green) — fan; W (white) — heating. For heat pumps: O (orange) — reversing valve (O=cooling in Trane/Carrier); B (blue) — reversing valve (B=cooling in Rheem/Ruud). Install steps: (1) Power off at breaker. (2) Photo the existing wiring before disconnecting. (3) Connect wires to matching terminals. (4) If C wire missing for smart thermostat: use the common adapter or run a new C wire. (5) Restore power and test heat and cool modes. Note: wire colors are conventions, not standards — always trace actual wiring before assuming.',
  },

  // ── Plumbing ─────────────────────────────────────────────────────────────────
  {
    category: 'plumbing',
    question: 'My toilet is running constantly. How do I diagnose and fix it?',
    answer: 'A running toilet wastes 200+ gallons per day. Diagnosis: (1) Flapper test — add food coloring to tank. If color appears in bowl without flushing, flapper is leaking. Replace flapper ($5-15, matches your toilet brand). (2) Float level — water should be 1 inch below overflow tube. If water is going into overflow tube, adjust float: bend float arm down (old ball float) or turn adjustment screw counterclockwise (newer floating cup). (3) Fill valve — listen for hissing after tank fills. If fill valve doesn\'t shut off, replace fill valve assembly ($15-25). (4) Overflow tube — if water level is correct but still running, check if water is trickling down overflow tube. Adjust float or replace fill valve. Most running toilet repairs cost under $30 in parts and take 30 minutes.',
  },
  {
    category: 'plumbing',
    question: 'How do I fix low water pressure in a single faucet or shower?',
    answer: 'Low pressure in one fixture only (not whole house): (1) Clean aerator — unscrew aerator from faucet tip, soak in white vinegar 30-60 minutes, clean debris, reinstall. Most common fix for faucets. (2) Clean showerhead — fill a bag with vinegar, tie around showerhead overnight, or unscrew and soak. (3) Partially closed supply valve — look under sink or behind shower for a shutoff valve. Ensure fully open (counterclockwise). (4) Cartridge buildup — in older faucets, mineral deposits can clog the cartridge. Replace cartridge for your faucet model. (5) Kinked supply line — flexible supply hoses can kink, especially after work under sink. Check and straighten. If whole-house pressure is low (below 45 PSI): check pressure reducing valve (PRV) near main shutoff — adjust or replace if needed.',
  },
  {
    category: 'plumbing',
    question: 'How do I relight the pilot light on a gas water heater?',
    answer: 'Relighting a gas water heater pilot: (1) Turn gas control knob to OFF. Wait 5 minutes to let any gas dissipate. (2) Turn knob to PILOT. (3) Push down the knob (or red button) to supply gas to pilot. (4) While holding down, use long-reach lighter or match to light the pilot at the burner. (5) Keep knob pressed 30-60 seconds after flame lights — this heats the thermocouple which signals gas to stay on. (6) Release knob slowly — flame should stay. If it goes out, repeat with longer hold time. (7) Turn knob to desired temperature (120°F/Hot recommended). (8) Listen for main burner to ignite. If pilot won\'t stay lit: thermocouple may be faulty (replace, $15-25), gas supply issue, or draft blowing out pilot. WARNING: if you smell strong gas, do not light pilot — evacuate and call gas company.',
  },
  {
    category: 'plumbing',
    question: 'How do I clear a slow or clogged drain?',
    answer: 'Drain clearing from mildest to strongest: (1) Boiling water — pour slowly down drain, pause, repeat. Dissolves soap/grease buildup. (2) Plunger — use cup plunger for sinks, flange plunger for toilets. Create seal, pump vigorously 15-20 times. (3) Baking soda + vinegar — pour 1/2 cup baking soda then 1/2 cup white vinegar, cover, wait 30 min, flush with hot water. (4) Drain snake/auger — insert 3-4 feet into drain, rotate to break up/pull out clog. Best for hair/debris clogs. (5) Clean the P-trap — place bucket under sink, unscrew trap, remove debris, reinstall. (6) Chemical drain cleaner — last resort, can damage pipes with repeated use. Avoid with PVC pipes and never mix with other chemicals. Prevention: use drain strainers, clean monthly with baking soda/vinegar.',
  },

  // ── Appliances ───────────────────────────────────────────────────────────────
  {
    category: 'appliance',
    question: 'My dryer runs but produces no heat. What is likely wrong?',
    answer: 'Dryer running without heat — most common causes by probability: (1) Blown thermal fuse (most common) — safety device that blows when dryer overheats. Almost always caused by clogged lint. Test with multimeter for continuity. Replace thermal fuse ($5-15) AND clean vent. (2) Clogged vent — lint buildup causes overheating. Clean full vent run from dryer to outside exhaust cap. (3) Failed heating element (electric dryers) — test with multimeter. Replace element ($15-50). (4) Gas supply issue (gas dryers) — check gas valve, igniter, and flame sensor. (5) High-limit thermostat failure — similar to thermal fuse. Test for continuity. (6) Control board issue — rare. Prevention: clean lint screen every load, clean vent duct annually, never run dryer unattended or when sleeping.',
  },
  {
    category: 'appliance',
    question: 'My dishwasher is not draining. How do I fix it?',
    answer: 'Dishwasher not draining — step-by-step: (1) Clean the filter — remove bottom rack, unscrew filter assembly in tub floor, clean under running water. This fixes 50% of drainage problems. (2) Check drain hose — should have a high loop under sink (above sink drain connection) or air gap device. A low loop lets water siphon back. (3) Check garbage disposal connection — if new disposal was installed, remove knockout plug inside disposal inlet. (4) Check/clean drain pump — remove standing water with towels, access pump at bottom of tub, clear any debris (glass, bones, labels). (5) Check for blockage in house drain — plunge the sink drain. (6) Test drain pump with multimeter — replace if no continuity (motor winding open). Run a diagnostic cycle while listening — pump should run during drain cycle.',
  },
  {
    category: 'appliance',
    question: 'My refrigerator is not cooling properly. What should I check?',
    answer: 'Refrigerator not cooling — diagnostic checklist: (1) Check condenser coils (back or bottom) — if coated with dust, cleaning often restores full cooling. Use vacuum and coil brush, clean annually. (2) Check condenser fan (near compressor) — should run when compressor runs. Fan failure prevents heat dissipation. (3) Check evaporator fan (inside freezer) — should circulate cold air. If freezer cools but fridge doesn\'t, evaporator fan may be stuck in ice or failed. (4) Check door gaskets — poor seal lets warm air in. Test with dollar bill — close door on bill, should have resistance when pulled. (5) Defrost system — if ice buildup on evaporator coils, defrost heater or timer has failed. Manual defrost: unplug 24-48 hours with doors open. (6) Thermistor/temperature sensor — controls compressor cycle. (7) Compressor — if clicking on and off, start relay may be failed (cheap fix). Compressor replacement is expensive — may warrant new unit.',
  },

  // ── General Maintenance ───────────────────────────────────────────────────────
  {
    category: 'general',
    question: 'What is included in a standard make-ready checklist for a rental unit?',
    answer: 'Make-ready checklist for rental unit turnover: ELECTRICAL: test all outlets and switches, replace dead light bulbs, test smoke/CO detectors (replace batteries), test GFCI outlets. PLUMBING: check for leaks under all sinks, test all faucets for hot and cold, test toilet flush and fill, check water heater temperature (120°F), inspect supply lines for bulging/corrosion. HVAC: replace air filter, test heat and cool cycles, clean supply/return vents, check thermostat operation. APPLIANCES: test all appliances (range, hood, dishwasher, refrigerator), clean interiors, check door seals. DOORS/WINDOWS: test all locks and deadbolts, lubricate hinges, check window operation and locks, inspect weatherstripping. SAFETY: fire extinguisher inspection, check railings, inspect for trip hazards. COSMETIC: touch-up paint, clean carpets, deep clean kitchen/bathrooms. Document with photos before and after.',
  },
  {
    category: 'general',
    question: 'How should I create an effective preventive maintenance schedule for a multifamily property?',
    answer: 'PM schedule framework: DAILY: visual inspection of common areas, check for water leaks or hazards, review work orders. WEEKLY: test pool/spa chemistry (if applicable), inspect exterior lighting, check HVAC in vacant units. MONTHLY: inspect fire extinguishers, test smoke and CO detectors in common areas, check HVAC filters (replace if needed), inspect roof drainage, clean dryer vents, lubricate door hardware. QUARTERLY: inspect HVAC systems (coils, belts, bearings), test emergency lighting, inspect plumbing for slow leaks, check caulking in bathrooms/kitchens, inspect water heaters. ANNUALLY: professional HVAC tune-up (heating before winter, cooling before summer), inspect roof condition, clean gutters, test backflow preventers, service fire alarm system, pump grease traps (if applicable), inspect elevators (if applicable). Track everything in your work order system. PM reduces emergency repairs by 40-60% and extends equipment life 2-3x.',
  },
  {
    category: 'general',
    question: 'What are the OSHA requirements for property maintenance workers?',
    answer: 'Key OSHA standards for property maintenance: PERSONAL PROTECTIVE EQUIPMENT (29 CFR 1910.132): Hard hat for overhead hazards, safety glasses/goggles, hearing protection (>85 dB), steel-toe boots, gloves, high-vis vest. ELECTRICAL SAFETY (29 CFR 1910.333): LOTO procedures, no work on energized circuits >50V without qualified training, insulated tools. FALL PROTECTION (29 CFR 1926.502): Guardrails, safety nets, or personal fall arrest systems required when working at heights of 6+ feet (construction) or 4+ feet (general industry). HAZARD COMMUNICATION (29 CFR 1910.1200): Safety Data Sheets (SDS) for all chemicals, proper labeling, employee training. CONFINED SPACE (29 CFR 1910.146): Permit-required for spaces with limited entry/exit and hazardous atmosphere (crawl spaces, mechanical rooms). RESPIRATORY PROTECTION: Required for asbestos, lead, mold work. Key: document all training, maintain inspection logs, conduct toolbox talks weekly.',
  },
  {
    category: 'general',
    question: 'How do I conduct a proper safety inspection of a rental property?',
    answer: 'Safety inspection checklist: FIRE SAFETY: smoke detector in every bedroom and outside sleeping areas (test all), CO detector on every level and near sleeping areas, fire extinguisher in kitchen (Class ABC, charged), no blocked exit pathways, functioning exit lighting in hallways, no hoarded materials. STRUCTURAL: inspect railings for stability (grab and shake — no movement), check stairs for secure treads, inspect deck/balcony attachments, no trip hazards in walkways, check for foundation cracks (>1/4 inch horizontal = serious). ELECTRICAL: no exposed wiring, no double-tapped breakers, GFCI in wet areas, no outlets near water, no overloaded extension cords. PLUMBING: no active leaks, water heater secured (seismic if required), no evidence of mold/moisture. WINDOWS: functional locks, no broken glass, working egress from bedrooms (min 20"x24" clear opening, 5.7 sq ft). Document everything with photos, date-stamped. Complete annually at minimum.',
  },
  {
    category: 'general',
    question: 'What is the proper way to document maintenance requests and repairs?',
    answer: 'Maintenance documentation best practices: WHEN RECEIVED: log date/time, unit number, tenant name, description in writing, priority level (emergency/urgent/routine). Use work order software or paper forms — never rely on memory. BEFORE STARTING: photo the problem, note existing conditions (pre-existing damage, code issues). DURING REPAIR: document parts used, time spent, subcontractor info if applicable. AFTER COMPLETION: photo the repair, note what was done and why, tenant signature or notification method and date. WHAT TO KEEP: all work orders (retain 3-7 years), vendor invoices, permits, inspection reports, warranty information. WHY IT MATTERS: (1) Protects against habitability claims, (2) Proves notice and response for liability, (3) Tracks recurring issues for capital planning, (4) Required for insurance claims, (5) Supports tax deductions. Use consistent numbering system. Archive completed work orders monthly.',
  },

  // ── Additional Technical Topics ───────────────────────────────────────────────
  {
    category: 'electrical',
    question: 'What is the difference between a 15-amp and 20-amp circuit, and when do I need each?',
    answer: '15-amp vs 20-amp circuits: 15-AMP: uses 14-gauge wire, standard duplex outlets (two slots + ground), handles up to 1,800W continuously (80% rule). Used for: general lighting, standard outlets in bedrooms and living rooms. 20-AMP: uses 12-gauge wire, receptacles have T-shaped neutral slot, handles up to 2,400W continuously. Required for: kitchen countertop circuits (code requires two 20A), bathrooms, garage circuits, laundry, refrigerator, dishwasher, microwave. HOW TO TELL: look at the breaker — 15A or 20A stamped on it. Look at the outlet — if one slot is T-shaped, it\'s on a 20A circuit. IMPORTANT: never replace 15A breaker with 20A without upgrading wire — 14-gauge wire is not rated for 20A and creates fire hazard. NEC code: kitchens require minimum two 20A small appliance circuits plus one dedicated for refrigerator.',
  },
  {
    category: 'hvac',
    question: 'How do I properly size a replacement air conditioner for a space?',
    answer: 'AC sizing (Manual J calculation simplified): RULE OF THUMB (starting point only): 1 ton (12,000 BTU) per 400-600 sq ft in moderate climate. Adjust for: high ceilings (+20%), poor insulation (+20%), very sunny or very shaded (-10%), extreme climate (+20-30%). BETTER METHOD — count heat sources: walls/windows/roof exposure, occupants, equipment. EXAMPLE: 1,200 sq ft apartment, moderate climate = 2-3 tons depending on conditions. OVERSIZING PROBLEMS: short-cycling (turns on/off too often), poor dehumidification (runs too short to remove moisture), higher humidity, more wear on compressor. UNDERSIZING PROBLEMS: runs constantly, never reaches setpoint, high energy bills. BEST PRACTICE: hire HVAC contractor to do Manual J calculation — equipment cost is too high to guess. Rule of thumb: if old unit worked at same size for 15 years, same size replacement is usually correct (unless adding insulation or windows changed).',
  },
  {
    category: 'plumbing',
    question: 'My water heater is making rumbling or popping sounds. What is causing it?',
    answer: 'Water heater rumbling/popping: PRIMARY CAUSE (95% of cases): sediment buildup. Over time, minerals (calcium, magnesium) settle on the tank floor. When the burner heats water trapped under sediment, it creates steam bubbles — the rumbling/popping sound. DIAGNOSIS: if sound occurs during heating cycle, it\'s almost certainly sediment. SOLUTION: flush the tank. (1) Turn off gas valve to PILOT or electric breaker off. (2) Connect garden hose to drain valve at bottom of tank. (3) Open a hot water faucet nearby (prevents vacuum). (4) Open drain valve, let water flow until clear (may take 20-30 min, very dirty on first flush). (5) Close valve, refill, restart. If tank is 10+ years old with heavy sediment, flushing may stir up sediment and cause leaks at old drain valve — consider replacement. PREVENTION: flush annually. Also check anode rod every 3-5 years — replace if less than 1/2 inch thick.',
  },
  {
    category: 'appliance',
    question: 'How do I clean a washing machine that has developed a mold smell?',
    answer: 'Washing machine mold smell — front-loader vs top-loader: FRONT-LOADER (common problem): (1) Run empty hot cycle with 2 cups white vinegar in drum, pause mid-cycle for 1 hour, complete cycle. (2) Run second empty hot cycle with 1/2 cup baking soda. (3) Clean gasket/door seal — wipe thoroughly with white vinegar and old toothbrush, especially under folds where water collects. (4) Clean detergent drawer — remove and soak in hot water/vinegar mix. (5) Leave door ajar after every wash to allow drying. PREVENTION: use HE detergent (low-suds, excess suds leave residue), run monthly hot maintenance cycle, wipe gasket after each use, remove clothes promptly. TOP-LOADER: similar process but focus on cleaning agitator, lid seal, and bleach/fabric softener dispensers. Commercial washer cleaning tablets (Affresh) work well monthly. Do not use bleach and vinegar together — creates harmful chlorine gas.',
  },
  {
    category: 'general',
    question: 'What are the most common causes of mold growth in buildings and how do I prevent it?',
    answer: 'Mold requires moisture, a food source (drywall, wood, carpet), and temperatures between 40-100°F. COMMON CAUSES: (1) Plumbing leaks — even small slow leaks behind walls. Fix any leak within 24-48 hours. (2) Poor ventilation — bathrooms and kitchens with inadequate exhaust. Ensure exhaust fans vent to OUTSIDE, not into attic. (3) High humidity — maintain indoor humidity 30-50%. Use dehumidifiers in basements/crawlspaces. (4) Condensation — cold surfaces in humid areas (pipes, windows, exterior walls). Insulate cold pipes, ensure vapor barriers. (5) Flooding/water intrusion — from roof, foundation, or window leaks. (6) HVAC condensate — clogged condensate drains. Clean annually. REMEDIATION (small areas, <10 sq ft): HEPA vacuum, clean with antimicrobial solution, allow to dry thoroughly, replace if material is porous. Larger areas: hire certified mold remediation contractor. IMPORTANT: mold testing is rarely needed — if you see it or smell it, remediate it.',
  },
  {
    category: 'plumbing',
    question: 'How do I shut off the water supply in an emergency plumbing situation?',
    answer: 'Water shutoff hierarchy: (1) FIXTURE SHUTOFF: for sink/toilet emergencies, look for oval or football-shaped valve under the fixture. Turn clockwise (right) to close. May be stiff if not operated recently. (2) APPLIANCE SHUTOFF: washing machine has two valves behind machine (hot and cold). Water heater has cold supply valve on top. (3) MAIN SHUTOFF — inside: usually near where water enters building (basement, crawl space, utility room). Gate valve (round wheel) or ball valve (lever). Turn clockwise to close. (4) MAIN SHUTOFF — outside: curb stop near street. Requires a meter key (T-bar or pentagon key). Turn clockwise. (5) CALL UTILITY: if curb stop fails or broken, call water utility for emergency shutoff. PREPARATION: know the location of your main shutoff BEFORE an emergency. Test it annually — old gate valves can fail to close completely. Consider replacing with a ball valve. Post shutoff location for tenants.',
  },
];

// ─── Sleep Utility ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main Seeding Logic ────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('🌱 MaintMentor Knowledge Base Seeder');
  console.log('━'.repeat(50));

  // ── 1. Ensure data directory exists ─────────────────────────────────────────
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Created data directory: ${DATA_DIR}`);
  }

  // ── 2. Check existing row count ──────────────────────────────────────────────
  console.log('\n📊 Checking existing knowledge_embeddings count...');
  let existingCount = 0;
  try {
    const { count, error } = await supabase
      .from('knowledge_embeddings')
      .select('id', { count: 'exact', head: true });

    if (error) {
      if (error.code === '42P01' || error.message.includes('does not exist')) {
        console.log('   ⚠️  knowledge_embeddings table does not exist yet.');
        console.log('   ℹ️  Run supabase/migrations/20260607_embeddings.sql first.');
        console.log('   Continuing with seed attempt (will fail gracefully if table missing)...');
      } else {
        console.log(`   ⚠️  Count check error: ${error.message}`);
      }
    } else {
      existingCount = count || 0;
      console.log(`   Found ${existingCount} existing rows.`);
    }
  } catch (err) {
    console.log(`   ⚠️  Could not check row count: ${err.message}`);
  }

  if (existingCount > ROW_WARN_THRESH && !FORCE_FLAG) {
    console.log(`\n⚠️  knowledge_embeddings already has ${existingCount} rows.`);
    console.log('   Re-seeding would create duplicates.');
    console.log('   Run with --force to seed anyway:');
    console.log('     node scripts/seed-knowledge-base.js --force');
    process.exit(0);
  }

  if (FORCE_FLAG && existingCount > 0) {
    console.log(`\n⚡ --force flag set — proceeding despite ${existingCount} existing rows.`);
  }

  // ── 3. Load content from DB or fallback ──────────────────────────────────────
  console.log('\n📚 Loading certification content from database...');
  let qaItems = [];
  let source = 'database';

  try {
    // Try certification_lessons
    const { data: lessons, error: lessonsErr } = await supabase
      .from('certification_lessons')
      .select('title, content_markdown')
      .limit(200);

    // Try certification_quiz_questions
    const { data: questions, error: questionsErr } = await supabase
      .from('certification_quiz_questions')
      .select('question_text, correct_answer, category')
      .limit(200);

    const dbItems = [];

    if (!lessonsErr && lessons && lessons.length > 0) {
      console.log(`   ✅ Found ${lessons.length} certification lessons`);
      for (const lesson of lessons) {
        if (lesson.title && lesson.content_markdown) {
          dbItems.push({
            category: 'certification',
            question: lesson.title,
            answer:   lesson.content_markdown,
          });
        }
      }
    } else {
      if (lessonsErr) {
        console.log(`   ℹ️  certification_lessons not available: ${lessonsErr.message}`);
      } else {
        console.log('   ℹ️  certification_lessons table is empty.');
      }
    }

    if (!questionsErr && questions && questions.length > 0) {
      console.log(`   ✅ Found ${questions.length} quiz questions`);
      for (const q of questions) {
        if (q.question_text && q.correct_answer) {
          dbItems.push({
            category: q.category || 'certification',
            question: q.question_text,
            answer:   q.correct_answer,
          });
        }
      }
    } else {
      if (questionsErr) {
        console.log(`   ℹ️  certification_quiz_questions not available: ${questionsErr.message}`);
      } else {
        console.log('   ℹ️  certification_quiz_questions table is empty.');
      }
    }

    if (dbItems.length > 0) {
      qaItems = dbItems;
      source = 'database';
      console.log(`   📊 Total from DB: ${qaItems.length} items`);
    } else {
      throw new Error('No DB content available — using fallback');
    }
  } catch (err) {
    console.log(`\n   ↩️  Falling back to hardcoded Q&A content: ${err.message}`);
    qaItems = FALLBACK_QA;
    source = 'hardcoded_fallback';
    console.log(`   📊 Fallback content: ${qaItems.length} items`);
  }

  // ── 4. Embed and insert each item ────────────────────────────────────────────
  console.log(`\n🚀 Seeding ${qaItems.length} items into knowledge_embeddings...`);
  console.log('   (Rate limited: 1 embedding per 100ms)\n');

  let seeded = 0;
  let skipped = 0;
  let errors = 0;
  const errorLog = [];

  for (let i = 0; i < qaItems.length; i++) {
    const item = qaItems[i];
    const label = `${item.category || 'general'} — ${item.question.slice(0, 60)}${item.question.length > 60 ? '...' : ''}`;

    process.stdout.write(`   Seeding ${i + 1}/${qaItems.length}: ${label}\n`);

    try {
      // Build content string (same format as the embedding worker)
      const content = `Q: ${item.question}\nA: ${item.answer}`;

      // Embed via Gemini
      const embedding = await embedText(content);

      // Insert into knowledge_embeddings
      const { error: insertError } = await supabase
        .from('knowledge_embeddings')
        .insert({
          content,
          embedding,
          metadata: {
            source:   'seed_script',
            category: item.category || 'general',
            version:  'day8_seed_v1',
          },
        });

      if (insertError) {
        throw new Error(`Insert failed: ${insertError.message}`);
      }

      seeded++;
      process.stdout.write(`   ✅ Done\n`);
    } catch (err) {
      errors++;
      const errMsg = err.message;
      errorLog.push({ index: i + 1, question: item.question.slice(0, 80), error: errMsg });
      process.stdout.write(`   ❌ Error: ${errMsg}\n`);
    }

    // Rate limit: wait 100ms between embeddings
    if (i < qaItems.length - 1) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  // ── 5. Final summary ─────────────────────────────────────────────────────────
  console.log('\n' + '━'.repeat(50));
  console.log('✅ Seeding complete!');
  console.log(`   Total items:  ${qaItems.length}`);
  console.log(`   Seeded:       ${seeded}`);
  console.log(`   Skipped:      ${skipped}`);
  console.log(`   Errors:       ${errors}`);

  if (errorLog.length > 0) {
    console.log('\n❌ Errors:');
    for (const e of errorLog) {
      console.log(`   [${e.index}] ${e.question}: ${e.error}`);
    }
  }

  // ── 6. Save summary file ─────────────────────────────────────────────────────
  const summary = {
    run_at:       new Date().toISOString(),
    source,
    force_flag:   FORCE_FLAG,
    total_items:  qaItems.length,
    seeded,
    skipped,
    errors,
    error_log:    errorLog,
  };

  try {
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
    console.log(`\n💾 Summary saved to: ${SUMMARY_FILE}`);
  } catch (err) {
    console.error(`   ⚠️  Could not save summary: ${err.message}`);
  }

  console.log('');
  process.exit(errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});
