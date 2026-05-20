/**
 * Topic Guard — MaintMentor API
 * Lightweight pre-check that deflects clearly off-topic requests
 * WITHOUT counting against the user's quota.
 */

// Maintenance-related keywords (expanded)
const MAINTENANCE_KEYWORDS = [
  // Trades
  'hvac', 'plumbing', 'electrical', 'roofing', 'painting', 'flooring', 'landscaping',
  'appliance', 'pool', 'spa', 'fencing', 'concrete', 'drywall', 'insulation',
  // Specific items
  'faucet', 'toilet', 'sink', 'drain', 'pipe', 'leak', 'water heater', 'boiler',
  'furnace', 'thermostat', 'air condition', 'ac unit', 'compressor', 'ductwork', 'vent',
  'outlet', 'switch', 'breaker', 'circuit', 'wire', 'wiring', 'gfci', 'light', 'fan',
  'washer', 'dryer', 'dishwasher', 'refrigerator', 'oven', 'stove', 'microwave',
  'garbage disposal', 'ice maker', 'freezer',
  'roof', 'shingle', 'gutter', 'flashing', 'soffit', 'attic',
  'paint', 'primer', 'caulk', 'spackle', 'stain',
  'tile', 'hardwood', 'laminate', 'vinyl', 'carpet', 'grout', 'subfloor',
  'door', 'window', 'lock', 'hinge', 'weatherstrip', 'screen',
  'sprinkler', 'irrigation', 'drainage', 'pressure wash',
  'pump', 'filter', 'chlorine', 'skimmer',
  // Actions
  'repair', 'fix', 'replace', 'install', 'troubleshoot', 'diagnose', 'maintain',
  'maintenance', 'broken', 'not working', 'leaking', 'clogged', 'stuck',
  'squeaking', 'rattling', 'buzzing', 'humming', 'dripping', 'running',
  'won\'t start', 'won\'t turn on', 'won\'t turn off', 'tripped', 'blown',
  // General home
  'house', 'home', 'apartment', 'property', 'building', 'unit', 'room',
  'bathroom', 'kitchen', 'basement', 'garage', 'crawlspace', 'crawl space',
  'tool', 'wrench', 'screwdriver', 'drill', 'pliers', 'hammer', 'saw',
  'cost', 'estimate', 'contractor', 'professional', 'diy', 'permit',
  'mold', 'mildew', 'rust', 'corrosion', 'rot', 'crack', 'hole',
  'water damage', 'flood', 'fire damage', 'storm damage',
  'safety', 'code', 'inspection', 'building code',
];

// Clearly off-topic patterns
const OFF_TOPIC_PATTERNS = [
  // Programming/tech
  /\b(python|javascript|java|c\+\+|react|node\.?js|css|html|api|database|sql|code|programming|coding|algorithm|function|variable|loop|debug)\b/i,
  // School/homework
  /\b(homework|essay|thesis|calculus|algebra|geometry|chemistry|physics|biology|history class|math problem|exam|test prep|study guide)\b/i,
  // Recipes/cooking (not appliance repair)
  /\b(recipe|cook|bake|ingredients|tablespoon|teaspoon|cup of flour|marinate|sautee|how to make .*(cake|bread|soup|pasta|chicken|steak))\b/i,
  // Medical
  /\b(symptom|diagnosis|medication|prescription|doctor|hospital|disease|illness|infection|pain in my|headache|fever|blood pressure|dosage)\b/i,
  // Legal
  /\b(lawsuit|attorney|legal advice|sue|court|judge|lawyer|statute|liability|legal right)\b/i,
  // Finance (beyond repair costs)
  /\b(stock|invest|bitcoin|crypto|portfolio|401k|mortgage rate|tax return|irs|trading|forex)\b/i,
  // Relationship/personal
  /\b(relationship|boyfriend|girlfriend|dating|marriage counseling|break ?up|divorce|love life)\b/i,
  // Politics/religion
  /\b(democrat|republican|liberal|conservative|election|vote|president|congress|bible|quran|church|mosque|pray|worship)\b/i,
  // Entertainment (not maintenance)
  /\b(movie|tv show|netflix|game|xbox|playstation|celebrity|gossip|score|championship|fantasy football)\b/i,
  // Creative writing
  /\b(write me a (poem|story|song|script)|tell me a joke|once upon a time)\b/i,
  // AI jailbreak attempts
  /\b(ignore (your|previous) (instructions|prompt)|pretend you are|act as|you are now|roleplay as|forget (your|all) rules|system prompt|jailbreak)\b/i,
];

// Override: questions that look off-topic but are actually maintenance-related
const MAINTENANCE_OVERRIDES = [
  /how (much|long|to|do I|should)/i,  // "how much does it cost" etc
  /can I do (this|it) myself/i,
  /should I call a (pro|professional|plumber|electrician|contractor)/i,
  /what tool/i,
  /is (this|it) (safe|dangerous|normal)/i,
  /where (to|can I) buy/i,
  /what (brand|model|type|size|kind)/i,
];

/**
 * Check if a query is on-topic (maintenance-related)
 * Returns { onTopic: bool, deflectionMessage: string|null }
 */
function checkTopic(question) {
  if (!question || typeof question !== 'string') {
    return { onTopic: true, deflectionMessage: null };
  }

  const q = question.toLowerCase().trim();
  
  // Very short queries — let them through (might be follow-ups)
  if (q.length < 10) {
    return { onTopic: true, deflectionMessage: null };
  }

  // Check for maintenance keywords first
  const hasMaintenanceKeyword = MAINTENANCE_KEYWORDS.some(kw => q.includes(kw));
  
  // Check override patterns
  const hasOverride = MAINTENANCE_OVERRIDES.some(pat => pat.test(q));

  if (hasMaintenanceKeyword || hasOverride) {
    return { onTopic: true, deflectionMessage: null };
  }

  // Check for off-topic patterns
  const matchedOffTopic = OFF_TOPIC_PATTERNS.some(pat => pat.test(q));

  if (matchedOffTopic) {
    return {
      onTopic: false,
      deflectionMessage: "Hey, I appreciate the question, but I'm your maintenance mentor — I stick to what I know best: repairs, troubleshooting, and keeping properties in top shape. Got a maintenance question? That's where I shine. 🔧",
    };
  }

  // If no maintenance keywords AND no clear off-topic match, let it through
  // (could be ambiguous — let Claude's system prompt handle it)
  return { onTopic: true, deflectionMessage: null };
}

module.exports = { checkTopic };
