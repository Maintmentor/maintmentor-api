-- ============================================================================
-- Day 13 Migration: Certification & Learning Platform
-- MaintMentor.ai — 2026-06-08
-- ============================================================================
-- Run this in Supabase Studio SQL Editor (Database → SQL Editor → New query)
-- ============================================================================

-- ─── 1. CERTIFICATION TRACKS ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS certification_tracks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  description      TEXT,
  icon             TEXT,
  difficulty_level TEXT NOT NULL DEFAULT 'beginner'
                     CHECK (difficulty_level IN ('beginner','intermediate','advanced')),
  estimated_hours  INT NOT NULL DEFAULT 4,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. CERTIFICATION MODULES ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS certification_modules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id    UUID NOT NULL REFERENCES certification_tracks(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  order_index INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 3. CERTIFICATION LESSONS ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS certification_lessons (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id           UUID NOT NULL REFERENCES certification_modules(id) ON DELETE CASCADE,
  track_id            UUID NOT NULL REFERENCES certification_tracks(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  content_markdown    TEXT,
  order_index         INT NOT NULL DEFAULT 0,
  estimated_minutes   INT NOT NULL DEFAULT 15,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 3b. PATCH: add missing columns to existing certification_lessons table ──
ALTER TABLE certification_lessons ADD COLUMN IF NOT EXISTS module_id UUID REFERENCES certification_modules(id) ON DELETE CASCADE;
ALTER TABLE certification_lessons ADD COLUMN IF NOT EXISTS track_id UUID REFERENCES certification_tracks(id) ON DELETE CASCADE;
ALTER TABLE certification_lessons ADD COLUMN IF NOT EXISTS content_markdown TEXT;
ALTER TABLE certification_lessons ADD COLUMN IF NOT EXISTS order_index INT NOT NULL DEFAULT 0;
ALTER TABLE certification_lessons ADD COLUMN IF NOT EXISTS estimated_minutes INT NOT NULL DEFAULT 15;

-- ─── 4. CERTIFICATION QUIZZES ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS certification_quizzes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id           UUID NOT NULL REFERENCES certification_modules(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  passing_score       INT NOT NULL DEFAULT 80,
  time_limit_minutes  INT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 5. CERTIFICATION QUESTIONS ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS certification_questions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id         UUID NOT NULL REFERENCES certification_quizzes(id) ON DELETE CASCADE,
  question_text   TEXT NOT NULL,
  question_type   TEXT NOT NULL DEFAULT 'multiple_choice'
                    CHECK (question_type IN ('multiple_choice','true_false','scenario')),
  options         JSONB,
  correct_answer  TEXT NOT NULL,
  explanation     TEXT,
  difficulty      TEXT NOT NULL DEFAULT 'beginner'
                    CHECK (difficulty IN ('beginner','intermediate','advanced')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 6. USER LESSON PROGRESS ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_lesson_progress (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lesson_id    UUID NOT NULL REFERENCES certification_lessons(id) ON DELETE CASCADE,
  completed    BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, lesson_id)
);

-- ─── 7. USER PROGRESS (API-facing, denormalized for fast lookups) ─────────────

CREATE TABLE IF NOT EXISTS user_progress (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lesson_id    UUID NOT NULL REFERENCES certification_lessons(id) ON DELETE CASCADE,
  track_id     UUID NOT NULL REFERENCES certification_tracks(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ,
  quiz_score   INT,
  passed       BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, lesson_id)
);

-- ─── 8. USER QUIZ ATTEMPTS ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_quiz_attempts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  quiz_id      UUID NOT NULL REFERENCES certification_quizzes(id) ON DELETE CASCADE,
  score        INT NOT NULL DEFAULT 0,
  passed       BOOLEAN NOT NULL DEFAULT false,
  answers      JSONB,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 9. USER CERTIFICATIONS ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_certifications (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  track_id           UUID NOT NULL REFERENCES certification_tracks(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'in_progress'
                       CHECK (status IN ('in_progress','completed','expired')),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  score              INT,
  certificate_number TEXT,
  UNIQUE (user_id, track_id)
);

-- ─── 10. CERTIFICATES (API-facing, issued certificates record) ────────────────

CREATE TABLE IF NOT EXISTS certificates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  track_id           UUID NOT NULL REFERENCES certification_tracks(id) ON DELETE CASCADE,
  certificate_number TEXT NOT NULL UNIQUE,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, track_id)
);

-- ─── RLS POLICIES ─────────────────────────────────────────────────────────────

ALTER TABLE certification_tracks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE certification_modules    ENABLE ROW LEVEL SECURITY;
ALTER TABLE certification_lessons    ENABLE ROW LEVEL SECURITY;
ALTER TABLE certification_quizzes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE certification_questions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_lesson_progress     ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_progress            ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_quiz_attempts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_certifications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE certificates             ENABLE ROW LEVEL SECURITY;

-- Catalog tables: anyone can read
DROP POLICY IF EXISTS "public_read_tracks"    ON certification_tracks;
DROP POLICY IF EXISTS "public_read_modules"   ON certification_modules;
DROP POLICY IF EXISTS "public_read_lessons"   ON certification_lessons;
DROP POLICY IF EXISTS "public_read_quizzes"   ON certification_quizzes;
DROP POLICY IF EXISTS "public_read_questions" ON certification_questions;

CREATE POLICY "public_read_tracks"    ON certification_tracks    FOR SELECT USING (true);
CREATE POLICY "public_read_modules"   ON certification_modules   FOR SELECT USING (true);
CREATE POLICY "public_read_lessons"   ON certification_lessons   FOR SELECT USING (true);
CREATE POLICY "public_read_quizzes"   ON certification_quizzes   FOR SELECT USING (true);
CREATE POLICY "public_read_questions" ON certification_questions FOR SELECT USING (true);

-- User-scoped tables: users see only their own rows
DROP POLICY IF EXISTS "users_own_lesson_progress"    ON user_lesson_progress;
DROP POLICY IF EXISTS "users_own_progress"           ON user_progress;
DROP POLICY IF EXISTS "users_own_quiz_attempts"      ON user_quiz_attempts;
DROP POLICY IF EXISTS "users_own_certifications"     ON user_certifications;
DROP POLICY IF EXISTS "users_own_certificates"       ON certificates;

CREATE POLICY "users_own_lesson_progress" ON user_lesson_progress
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_own_progress" ON user_progress
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_own_quiz_attempts" ON user_quiz_attempts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_own_certifications" ON user_certifications
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_own_certificates" ON certificates
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ─── SEED DATA ────────────────────────────────────────────────────────────────

-- Insert 4 tracks (idempotent)
INSERT INTO certification_tracks (id, name, slug, description, icon, difficulty_level, estimated_hours)
VALUES
  ('11111111-1111-1111-1111-111111111101', 'Electrical Fundamentals',
   'electrical',
   'Master residential electrical systems: outlets, breakers, wiring, GFCI/AFCI, ceiling fans, and safety protocols.',
   'zap', 'intermediate', 6),

  ('11111111-1111-1111-1111-111111111102', 'HVAC Essentials',
   'hvac',
   'Understand heating, cooling, and ventilation systems. Covers thermostats, filters, ductwork, and seasonal maintenance.',
   'thermometer', 'beginner', 5),

  ('11111111-1111-1111-1111-111111111103', 'Plumbing Basics',
   'plumbing',
   'Learn faucets, toilets, water heaters, drain care, garbage disposals, and shutoff valves.',
   'droplets', 'beginner', 4),

  ('11111111-1111-1111-1111-111111111104', 'General Home Maintenance',
   'general',
   'Comprehensive home care: weatherproofing, appliances, painting, caulking, seasonal checklists, and preventative care.',
   'wrench', 'beginner', 8)
ON CONFLICT (slug) DO NOTHING;

-- ─── ELECTRICAL MODULES & LESSONS ─────────────────────────────────────────────

INSERT INTO certification_modules (id, track_id, name, description, order_index)
VALUES
  ('22222222-2222-2222-2222-222222222201',
   '11111111-1111-1111-1111-111111111101',
   'Electrical Safety & Basics', 'Safety first — understanding your home electrical system', 1),
  ('22222222-2222-2222-2222-222222222202',
   '11111111-1111-1111-1111-111111111101',
   'Outlets, Switches & Fixtures', 'Common DIY electrical tasks', 2),
  ('22222222-2222-2222-2222-222222222203',
   '11111111-1111-1111-1111-111111111101',
   'Breaker Panels & Wiring', 'Understanding your panel and circuit basics', 3)
ON CONFLICT DO NOTHING;

INSERT INTO certification_lessons (id, module_id, track_id, title, content_markdown, order_index, estimated_minutes)
VALUES
  ('33333333-3333-3333-3333-333333333301',
   '22222222-2222-2222-2222-222222222201',
   '11111111-1111-1111-1111-111111111101',
   'How Home Electrical Systems Work',
   E'# How Home Electrical Systems Work\n\nYour home electrical system brings power from the utility grid through a meter, into your service panel (breaker box), and distributes it through circuits to every outlet, switch, and fixture.\n\n## Key Components\n- **Service entrance**: Where power enters from the street\n- **Main breaker**: Shuts off all power to your home\n- **Circuit breakers**: Protect individual circuits from overload\n- **Hot, neutral, and ground wires**: The three conductors in most circuits\n\n## Safety Rules\n1. Always turn off the breaker before working on any circuit\n2. Test with a non-contact voltage tester — never assume a wire is dead\n3. When in doubt, call a licensed electrician\n\n## Understanding Voltage\nMost outlets are 120V. Large appliances (dryers, ranges, AC units) use 240V circuits with two hot wires.',
   1, 20),

  ('33333333-3333-3333-3333-333333333302',
   '22222222-2222-2222-2222-222222222201',
   '11111111-1111-1111-1111-111111111101',
   'Electrical Safety Protocols',
   E'# Electrical Safety Protocols\n\nElectricity is unforgiving. These protocols protect you every time.\n\n## Before You Start\n- Identify the correct breaker and turn it OFF\n- Place a "Do Not Turn On" note on the panel\n- Test with a non-contact voltage tester\n- Never work alone on electrical projects\n\n## PPE and Tools\n- Use insulated tools rated 1000V+\n- Rubber-soled shoes\n- Safety glasses\n- Work in dry conditions only\n\n## GFCI and AFCI Protection\n**GFCI** (Ground Fault Circuit Interrupter): Required near water — kitchens, bathrooms, garages, outdoors. Press TEST monthly.\n\n**AFCI** (Arc Fault Circuit Interrupter): Required in bedrooms and living areas. Prevents fires from arcing faults.',
   2, 15),

  ('33333333-3333-3333-3333-333333333303',
   '22222222-2222-2222-2222-222222222202',
   '11111111-1111-1111-1111-111111111101',
   'Replacing Outlets and Switches',
   E'# Replacing Outlets and Switches\n\nReplacing a standard outlet or switch is one of the most common DIY electrical tasks.\n\n## Tools Needed\n- Flathead and Phillips screwdrivers\n- Non-contact voltage tester\n- Wire stripper\n- Needle-nose pliers\n\n## Step-by-Step: Replacing an Outlet\n1. Turn off breaker, verify with tester\n2. Remove cover plate (one screw)\n3. Unscrew outlet from box (two screws)\n4. Pull outlet out, photograph wire connections\n5. Note: black=hot, white=neutral, bare copper=ground\n6. Disconnect wires from old outlet\n7. Connect to new outlet: hot→brass screw, neutral→silver screw, ground→green screw\n8. Push back into box, screw in, replace cover\n9. Restore power and test\n\n## Upgrading to GFCI\nGFCI outlets have LINE and LOAD terminals. Connect incoming wires to LINE terminals. Optional: protect downstream outlets using LOAD terminals.',
   1, 25)
ON CONFLICT DO NOTHING;

-- ─── HVAC MODULES & LESSONS ───────────────────────────────────────────────────

INSERT INTO certification_modules (id, track_id, name, description, order_index)
VALUES
  ('22222222-2222-2222-2222-222222222211',
   '11111111-1111-1111-1111-111111111102',
   'HVAC Fundamentals', 'How heating and cooling systems work', 1),
  ('22222222-2222-2222-2222-222222222212',
   '11111111-1111-1111-1111-111111111102',
   'Filters, Airflow & Ductwork', 'Maintenance tasks every homeowner should know', 2),
  ('22222222-2222-2222-2222-222222222213',
   '11111111-1111-1111-1111-111111111102',
   'Thermostats & Controls', 'Getting the most from your HVAC controls', 3)
ON CONFLICT DO NOTHING;

INSERT INTO certification_lessons (id, module_id, track_id, title, content_markdown, order_index, estimated_minutes)
VALUES
  ('33333333-3333-3333-3333-333333333311',
   '22222222-2222-2222-2222-222222222211',
   '11111111-1111-1111-1111-111111111102',
   'How Central HVAC Systems Work',
   E'# How Central HVAC Systems Work\n\n## The Heating Cycle\nYour furnace burns fuel (or uses electric resistance) to heat air, which a blower fan pushes through ductwork to supply registers in each room. Return registers pull cool air back to be reheated.\n\n## The Cooling Cycle\nYour AC system uses refrigerant to absorb heat from indoor air and reject it outside. The evaporator coil (inside) absorbs heat; the condenser coil (outside) releases it.\n\n## Key Components\n- **Air handler / furnace**: Indoor unit with blower\n- **Condenser**: Outdoor unit with compressor and fan\n- **Ductwork**: Distributes conditioned air\n- **Thermostat**: Controls when the system runs\n- **Filter**: Protects equipment from dust\n\n## Seasonal Maintenance\n- Spring: Clean condenser, check refrigerant lines, replace filter\n- Fall: Replace filter, test heat, check flue vent',
   1, 20),

  ('33333333-3333-3333-3333-333333333312',
   '22222222-2222-2222-2222-222222222211',
   '11111111-1111-1111-1111-111111111102',
   'HVAC Efficiency and Energy Savings',
   E'# HVAC Efficiency and Energy Savings\n\nYour HVAC system typically accounts for 40-50% of your energy bill. Small changes deliver big savings.\n\n## SEER and AFUE Ratings\n- **SEER** (Seasonal Energy Efficiency Ratio): AC efficiency. Higher = better. 14 SEER is minimum; 20+ is excellent.\n- **AFUE** (Annual Fuel Utilization Efficiency): Furnace efficiency. 80% is standard; 95%+ is high-efficiency.\n\n## Quick Wins\n1. Change filters every 1-3 months — dirty filters cost 5-15% more to operate\n2. Seal duct leaks with mastic tape (not duct tape — it fails)\n3. Add programmable or smart thermostat\n4. Keep condenser clear of debris (18" clearance)\n5. Insulate attic to reduce cooling load\n\n## Temperature Setpoints\n- Summer: 78°F when home, 85°F when away\n- Winter: 68°F when home, 62°F when away',
   2, 15),

  ('33333333-3333-3333-3333-333333333313',
   '22222222-2222-2222-2222-222222222212',
   '11111111-1111-1111-1111-111111111102',
   'Air Filters: Types, Ratings, and Replacement',
   E'# Air Filters: Types, Ratings, and Replacement\n\n## MERV Ratings\nMERV (Minimum Efficiency Reporting Value) measures filter efficiency:\n- **MERV 1-4**: Fiberglass, basic protection, cheap\n- **MERV 8-11**: Pleated filters, good for most homes\n- **MERV 13-16**: Hospital-grade, great for allergies — but can restrict airflow\n\n## Recommended: MERV 8-11\nMost residential systems work best with MERV 8-11. High-MERV filters can starve your blower of air, increasing wear.\n\n## Replacement Schedule\n- 1" filters: Every 1-2 months\n- 4" filters: Every 6-12 months\n- Homes with pets/allergies: More frequently\n\n## How to Change\n1. Turn system off (not critical but cleaner)\n2. Note arrow direction on old filter (points toward air handler)\n3. Slide out old filter — dispose of immediately (it''s full of dust)\n4. Slide in new filter with arrow pointing toward air handler\n5. Note change date on filter edge',
   1, 15)
ON CONFLICT DO NOTHING;

-- ─── PLUMBING MODULES & LESSONS ───────────────────────────────────────────────

INSERT INTO certification_modules (id, track_id, name, description, order_index)
VALUES
  ('22222222-2222-2222-2222-222222222221',
   '11111111-1111-1111-1111-111111111103',
   'Plumbing Fundamentals', 'Supply, drain, and venting basics', 1),
  ('22222222-2222-2222-2222-222222222222',
   '11111111-1111-1111-1111-111111111103',
   'Faucets, Toilets & Fixtures', 'Common repairs and maintenance', 2),
  ('22222222-2222-2222-2222-222222222223',
   '11111111-1111-1111-1111-111111111103',
   'Water Heaters & Drains', 'Water heating and drainage maintenance', 3)
ON CONFLICT DO NOTHING;

INSERT INTO certification_lessons (id, module_id, track_id, title, content_markdown, order_index, estimated_minutes)
VALUES
  ('33333333-3333-3333-3333-333333333321',
   '22222222-2222-2222-2222-222222222221',
   '11111111-1111-1111-1111-111111111103',
   'Your Home Plumbing System Explained',
   E'# Your Home Plumbing System Explained\n\n## Two Systems in One\nResidential plumbing has two separate systems:\n1. **Supply system**: Delivers pressurized hot and cold water\n2. **Drain-waste-vent (DWV) system**: Removes wastewater by gravity\n\n## Supply System\nWater enters from the street through a main shutoff valve. Cold water splits to fixtures; some goes to the water heater for hot supply. Pressure is typically 40-80 PSI.\n\n**Find your main shutoff**: Usually near the water meter, in the basement, or outside near the foundation. Know where it is before an emergency.\n\n## DWV System\nAll drains slope downward at 1/4" per foot to carry waste. Vent pipes go up through the roof to maintain atmospheric pressure (prevents siphoning of P-traps).\n\n## P-Traps\nThe curved pipe under every fixture holds water to block sewer gases. If a fixture smells like sewage, the P-trap may be dry — just run water for 30 seconds.',
   1, 20),

  ('33333333-3333-3333-3333-333333333322',
   '22222222-2222-2222-2222-222222222221',
   '11111111-1111-1111-1111-111111111103',
   'Shutoff Valves and Emergency Response',
   E'# Shutoff Valves and Emergency Response\n\n## Types of Shutoff Valves\n- **Ball valve**: Quarter-turn, very reliable, lever handle\n- **Gate valve**: Multi-turn wheel, older homes, prone to failure\n- **Angle stop**: Under fixtures (toilets, sinks), controls one fixture\n\n## Location Map — Know These!\n1. **Main shutoff**: Stops all water to the house\n2. **Toilet supply line**: Small valve on the wall behind toilet\n3. **Sink supply lines**: Under the sink cabinet\n4. **Washing machine**: Behind or beside the machine\n5. **Water heater**: Cold supply inlet at top\n\n## Emergency Response: Water Leak\n1. Stay calm\n2. Turn off the nearest shutoff valve\n3. If fixture valve doesn''t stop it → main shutoff\n4. Place towels, get buckets\n5. Dry the area to prevent mold (within 24-48 hours)\n6. Call a plumber if you can''t identify the source',
   2, 15),

  ('33333333-3333-3333-3333-333333333323',
   '22222222-2222-2222-2222-222222222222',
   '11111111-1111-1111-1111-111111111103',
   'Fixing Running Toilets',
   E'# Fixing Running Toilets\n\nA running toilet wastes 200+ gallons per day. Most fixes cost under $20.\n\n## Diagnose First\nLift the tank lid and watch. Three common causes:\n\n### 1. Flapper Not Sealing\nFlapper is worn or warped. Test: Put food coloring in tank. If it appears in bowl without flushing — replace the flapper ($5-10).\n\n**Fix**: Drain tank (turn off supply, flush), unhook flapper from ears on overflow tube, take to hardware store to match, install new one.\n\n### 2. Float Too High\nWater runs into overflow tube constantly. Adjust the float arm down until water stops 1" below top of overflow tube.\n\n### 3. Fill Valve Worn\nHissing sound from the fill valve. Replace entire fill valve assembly ($15). Turn off supply, flush, disconnect supply line, unscrew fill valve, install new one.\n\n## Tips\n- Korky and Fluidmaster are reliable brands\n- Replace all three parts together for older toilets (kit = $20)\n- Always turn off the supply valve before any toilet repair',
   1, 20)
ON CONFLICT DO NOTHING;

-- ─── GENERAL HOME MAINTENANCE MODULES & LESSONS ───────────────────────────────

INSERT INTO certification_modules (id, track_id, name, description, order_index)
VALUES
  ('22222222-2222-2222-2222-222222222231',
   '11111111-1111-1111-1111-111111111104',
   'Preventative Maintenance', 'Seasonal checklists and inspection routines', 1),
  ('22222222-2222-2222-2222-222222222232',
   '11111111-1111-1111-1111-111111111104',
   'Weatherproofing & Insulation', 'Keep the outside out and comfort in', 2),
  ('22222222-2222-2222-2222-222222222233',
   '11111111-1111-1111-1111-111111111104',
   'Appliances & Interior', 'Appliance maintenance and interior upkeep', 3)
ON CONFLICT DO NOTHING;

INSERT INTO certification_lessons (id, module_id, track_id, title, content_markdown, order_index, estimated_minutes)
VALUES
  ('33333333-3333-3333-3333-333333333331',
   '22222222-2222-2222-2222-222222222231',
   '11111111-1111-1111-1111-111111111104',
   'The Annual Home Maintenance Checklist',
   E'# The Annual Home Maintenance Checklist\n\nProactive maintenance prevents 80% of costly repairs. Here is your year-round schedule.\n\n## Spring (March–May)\n- [ ] Replace HVAC filter\n- [ ] Schedule AC tune-up\n- [ ] Clean gutters and check for winter damage\n- [ ] Inspect roof for missing/damaged shingles\n- [ ] Test smoke and CO detectors, replace batteries\n- [ ] Check exterior caulking around windows/doors\n- [ ] Flush water heater sediment\n\n## Summer (June–August)\n- [ ] Check AC refrigerant lines for ice buildup\n- [ ] Inspect deck/patio for rot and loose fasteners\n- [ ] Clean dryer vent (lint buildup = fire hazard)\n- [ ] Check attic for proper ventilation\n\n## Fall (September–November)\n- [ ] Schedule furnace tune-up\n- [ ] Drain and store garden hoses\n- [ ] Insulate exposed pipes in unheated spaces\n- [ ] Clean fireplace/chimney\n- [ ] Reverse ceiling fans (clockwise for winter)\n\n## Winter (December–February)\n- [ ] Check weatherstripping on all exterior doors\n- [ ] Monitor for ice dams on roof\n- [ ] Keep thermostat above 55°F to prevent pipe freezes',
   1, 25),

  ('33333333-3333-3333-3333-333333333332',
   '22222222-2222-2222-2222-222222222231',
   '11111111-1111-1111-1111-111111111104',
   'Smoke Detectors, CO Detectors, and Fire Safety',
   E'# Smoke Detectors, CO Detectors, and Fire Safety\n\n## Placement Requirements\n- Smoke detectors: Every bedroom, outside each sleeping area, and on every level\n- CO detectors: Near sleeping areas and on every level\n- Combination units: Satisfy both requirements\n\n## Testing and Maintenance\n- Test monthly (press test button)\n- Replace batteries annually (or use 10-year lithium batteries)\n- Replace the entire unit every 10 years (sensor degrades)\n\n## Ionization vs Photoelectric Smoke Detectors\n- **Ionization**: Faster at detecting flaming fires\n- **Photoelectric**: Better at detecting slow, smoldering fires\n- **Best practice**: Have both types or use combination units\n\n## CO Safety\nCarbon monoxide is odorless, colorless — "the silent killer." Sources: furnaces, water heaters, fireplaces, attached garage vehicles.\n\n**If your CO alarm sounds**: Get everyone outside immediately, call 911, do not re-enter until cleared by fire department.',
   2, 15),

  ('33333333-3333-3333-3333-333333333333',
   '22222222-2222-2222-2222-222222222232',
   '11111111-1111-1111-1111-111111111104',
   'Caulking, Weatherstripping, and Air Sealing',
   E'# Caulking, Weatherstripping, and Air Sealing\n\nAir leaks account for 25-40% of heating and cooling energy loss in most homes.\n\n## Where to Caulk\n- Window and door frames (exterior)\n- Where siding meets foundation\n- Around pipes, wires, and ducts penetrating exterior walls\n- Baseboards in older homes\n- Around bathtubs and showers (interior — use silicone)\n\n## Choosing the Right Caulk\n- **Silicone**: Wet areas (baths, kitchens), very durable, not paintable\n- **Latex/acrylic**: Trim, windows, paintable, easier to apply\n- **Foam backer rod**: Fill large gaps before caulking\n\n## Weatherstripping Types\n- **V-strip (tension seal)**: Long-lasting, good for door/window sides\n- **Foam tape**: Easy, cheap, works for irregular gaps\n- **Door sweeps**: Seals the bottom gap under exterior doors\n\n## How to Apply Caulk\n1. Clean and dry the surface\n2. Remove old caulk with utility knife or caulk remover\n3. Cut tip at 45° angle, 1/4" opening\n4. Apply steady bead, push don''t pull\n5. Smooth with wet finger or caulk tool\n6. Let cure 24 hours before moisture exposure',
   1, 20)
ON CONFLICT DO NOTHING;

-- ─── SAMPLE QUIZ DATA ─────────────────────────────────────────────────────────

INSERT INTO certification_quizzes (id, module_id, title, passing_score, time_limit_minutes)
VALUES
  ('44444444-4444-4444-4444-444444444401',
   '22222222-2222-2222-2222-222222222201',
   'Electrical Safety & Basics Quiz', 80, 10),
  ('44444444-4444-4444-4444-444444444411',
   '22222222-2222-2222-2222-222222222211',
   'HVAC Fundamentals Quiz', 80, 10),
  ('44444444-4444-4444-4444-444444444421',
   '22222222-2222-2222-2222-222222222221',
   'Plumbing Fundamentals Quiz', 80, 10),
  ('44444444-4444-4444-4444-444444444431',
   '22222222-2222-2222-2222-222222222231',
   'Preventative Maintenance Quiz', 80, 10)
ON CONFLICT DO NOTHING;

INSERT INTO certification_questions (id, quiz_id, question_text, question_type, options, correct_answer, explanation, difficulty)
VALUES
  ('55555555-5555-5555-5555-555555555501',
   '44444444-4444-4444-4444-444444444401',
   'What tool should you always use to verify power is off before working on an electrical circuit?',
   'multiple_choice',
   '[{"label":"A","value":"A voltmeter"},{"label":"B","value":"A non-contact voltage tester"},{"label":"C","value":"A multimeter"},{"label":"D","value":"Your finger"}]',
   'B', 'A non-contact voltage tester is the safest tool — it detects live voltage without touching the wire.', 'beginner'),

  ('55555555-5555-5555-5555-555555555502',
   '44444444-4444-4444-4444-444444444401',
   'GFCI outlets are required near water sources.',
   'true_false',
   '[{"label":"True","value":"true"},{"label":"False","value":"false"}]',
   'true', 'GFCI protection is required by code in kitchens, bathrooms, garages, outdoors, and anywhere near water.', 'beginner'),

  ('55555555-5555-5555-5555-555555555503',
   '44444444-4444-4444-4444-444444444411',
   'What MERV rating range is best for most residential HVAC systems?',
   'multiple_choice',
   '[{"label":"A","value":"1-4"},{"label":"B","value":"8-11"},{"label":"C","value":"13-16"},{"label":"D","value":"17-20"}]',
   'B', 'MERV 8-11 provides good filtration without restricting airflow in typical residential systems.', 'beginner'),

  ('55555555-5555-5555-5555-555555555504',
   '44444444-4444-4444-4444-444444444421',
   'What prevents sewer gases from entering your home through drain pipes?',
   'multiple_choice',
   '[{"label":"A","value":"The main shutoff valve"},{"label":"B","value":"The vent stack"},{"label":"C","value":"The P-trap"},{"label":"D","value":"The water meter"}]',
   'C', 'P-traps hold a water seal that blocks sewer gases. If a drain smells, run water to refill a dry P-trap.', 'beginner'),

  ('55555555-5555-5555-5555-555555555505',
   '44444444-4444-4444-4444-444444444431',
   'How often should smoke detector batteries be replaced (if not using 10-year lithium)?',
   'multiple_choice',
   '[{"label":"A","value":"Every month"},{"label":"B","value":"Every 6 months"},{"label":"C","value":"Annually"},{"label":"D","value":"Every 5 years"}]',
   'C', 'Replace smoke detector batteries annually. Many people do it when clocks change in fall. Replace the entire unit every 10 years.', 'beginner')
ON CONFLICT DO NOTHING;

-- ─── DONE ─────────────────────────────────────────────────────────────────────
-- Tables created, RLS enabled, seed data inserted.
-- The frontend certification service will now work against real data.
-- ============================================================================
