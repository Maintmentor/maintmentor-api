// ─── Hero Avatar System Routes ──────────────────────────────────────────────
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU';

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// XP rank thresholds
const RANK_THRESHOLDS = [
  { rank: 'legend', minXp: 10000 },
  { rank: 'master', minXp: 2500 },
  { rank: 'journeyman', minXp: 500 },
  { rank: 'rookie', minXp: 0 },
];

function computeRank(xp) {
  for (const t of RANK_THRESHOLDS) {
    if (xp >= t.minXp) return t.rank;
  }
  return 'rookie';
}

function nextRankInfo(xp) {
  if (xp >= 10000) return { nextRank: null, xpNeeded: 0, xpForNext: 0 };
  if (xp >= 2500) return { nextRank: 'legend', xpNeeded: 10000 - xp, xpForNext: 10000 };
  if (xp >= 500) return { nextRank: 'master', xpNeeded: 2500 - xp, xpForNext: 2500 };
  return { nextRank: 'journeyman', xpNeeded: 500 - xp, xpForNext: 500 };
}

// Award XP helper (used by routes and chat integration)
async function awardXP(userId, amount, action) {
  if (!userId || !amount) return null;
  const supabase = getSupabase();

  // Get or create user hero
  let { data: hero, error } = await supabase
    .from('user_heroes')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (!hero) {
    // No hero selected yet - skip XP award
    return null;
  }

  const newXp = (hero.xp || 0) + amount;
  const newRank = computeRank(newXp);
  const today = new Date().toISOString().split('T')[0];

  // Update streak
  let streakDays = hero.streak_days || 0;
  if (hero.last_active_date) {
    const lastDate = new Date(hero.last_active_date);
    const todayDate = new Date(today);
    const diffDays = Math.floor((todayDate - lastDate) / (1000 * 60 * 60 * 24));
    if (diffDays === 1) {
      streakDays += 1;
    } else if (diffDays > 1) {
      streakDays = 1;
    }
    // Same day = no change
  } else {
    streakDays = 1;
  }

  const { data: updated, error: updateErr } = await supabase
    .from('user_heroes')
    .update({
      xp: newXp,
      rank: newRank,
      streak_days: streakDays,
      last_active_date: today,
    })
    .eq('user_id', userId)
    .select()
    .single();

  if (updateErr) {
    console.error('[Hero] XP update error:', updateErr);
    return null;
  }

  console.log(`[Hero] XP awarded: ${userId} +${amount} (${action}) → ${newXp} XP, rank: ${newRank}`);
  return updated;
}

function registerHeroRoutes(app) {
  // GET /api/heroes — list all available hero avatars
  app.get('/api/heroes', async (req, res) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('hero_avatars')
        .select('*')
        .order('trade');

      if (error) throw error;
      res.json({ success: true, heroes: data });
    } catch (err) {
      console.error('[Hero] List error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/heroes/select — user selects their hero
  app.post('/api/heroes/select', async (req, res) => {
    const { userId, heroId, heroName } = req.body;
    if (!userId || !heroId) {
      return res.status(400).json({ success: false, error: 'Missing userId or heroId' });
    }

    try {
      const supabase = getSupabase();

      // Get hero avatar info for default name
      const { data: avatar } = await supabase
        .from('hero_avatars')
        .select('name')
        .eq('id', heroId)
        .single();

      const finalName = heroName || (avatar ? avatar.name : 'Hero');

      // Upsert - create or update user's hero selection
      const { data, error } = await supabase
        .from('user_heroes')
        .upsert({
          user_id: userId,
          hero_id: heroId,
          hero_name: finalName,
          xp: 0,
          rank: 'rookie',
          streak_days: 0,
          last_active_date: new Date().toISOString().split('T')[0],
          created_at: new Date().toISOString(),
        }, { onConflict: 'user_id' })
        .select()
        .single();

      if (error) throw error;

      console.log(`[Hero] Selected: ${userId} → ${finalName} (${heroId})`);
      res.json({ success: true, userHero: data });
    } catch (err) {
      console.error('[Hero] Select error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/heroes/profile/:userId — get user's hero profile
  app.get('/api/heroes/profile/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const supabase = getSupabase();

      // Get user hero with avatar info
      const { data: userHero, error } = await supabase
        .from('user_heroes')
        .select('*, hero_avatars(*)')
        .eq('user_id', userId)
        .single();

      if (error || !userHero) {
        return res.json({ success: true, profile: null, hasHero: false });
      }

      // Get badges
      const { data: badges } = await supabase
        .from('hero_badges')
        .select('*')
        .eq('user_id', userId)
        .order('earned_at', { ascending: false });

      const rankInfo = nextRankInfo(userHero.xp || 0);

      res.json({
        success: true,
        hasHero: true,
        profile: {
          ...userHero,
          avatar: userHero.hero_avatars,
          badges: badges || [],
          rankInfo,
        },
      });
    } catch (err) {
      console.error('[Hero] Profile error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/heroes/xp — award XP
  app.post('/api/heroes/xp', async (req, res) => {
    const { userId, action, amount } = req.body;
    if (!userId || !amount) {
      return res.status(400).json({ success: false, error: 'Missing userId or amount' });
    }

    try {
      const result = await awardXP(userId, amount, action || 'manual');
      if (!result) {
        return res.json({ success: true, message: 'No hero selected yet' });
      }
      res.json({ success: true, userHero: result });
    } catch (err) {
      console.error('[Hero] XP error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/heroes/leaderboard — top heroes by XP
  app.get('/api/heroes/leaderboard', async (req, res) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('user_heroes')
        .select('*, hero_avatars(name, trade, icon_emoji, tagline)')
        .order('xp', { ascending: false })
        .limit(20);

      if (error) throw error;

      // Enrich with profile display names
      const userIds = data.map(d => d.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, full_name')
        .in('id', userIds);

      const profileMap = {};
      (profiles || []).forEach(p => {
        profileMap[p.id] = p.display_name || p.full_name || 'Anonymous';
      });

      const leaderboard = data.map((entry, idx) => ({
        position: idx + 1,
        userId: entry.user_id,
        heroName: entry.hero_name,
        userName: profileMap[entry.user_id] || 'Anonymous',
        xp: entry.xp,
        rank: entry.rank,
        streakDays: entry.streak_days,
        avatar: entry.hero_avatars,
      }));

      res.json({ success: true, leaderboard });
    } catch (err) {
      console.error('[Hero] Leaderboard error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/heroes/team/:orgId — team roster
  app.get('/api/heroes/team/:orgId', async (req, res) => {
    const { orgId } = req.params;
    try {
      const supabase = getSupabase();

      // Get team members
      const { data: members } = await supabase
        .from('team_members')
        .select('user_id, role')
        .eq('organization_id', orgId);

      if (!members || members.length === 0) {
        return res.json({ success: true, roster: [], stats: {} });
      }

      const userIds = members.map(m => m.user_id);

      // Get heroes for these users
      const { data: heroes } = await supabase
        .from('user_heroes')
        .select('*, hero_avatars(name, trade, icon_emoji, tagline)')
        .in('user_id', userIds);

      // Get profiles
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, full_name')
        .in('id', userIds);

      const profileMap = {};
      (profiles || []).forEach(p => {
        profileMap[p.id] = p.display_name || p.full_name || 'Team Member';
      });

      const memberMap = {};
      (members || []).forEach(m => { memberMap[m.user_id] = m.role; });

      const roster = (heroes || []).map(h => ({
        userId: h.user_id,
        userName: profileMap[h.user_id] || 'Team Member',
        role: memberMap[h.user_id] || 'member',
        heroName: h.hero_name,
        xp: h.xp,
        rank: h.rank,
        streakDays: h.streak_days,
        avatar: h.hero_avatars,
      }));

      // Aggregate stats
      const totalXp = roster.reduce((sum, r) => sum + (r.xp || 0), 0);
      const avgXp = roster.length > 0 ? Math.round(totalXp / roster.length) : 0;
      const activeToday = roster.filter(r => {
        const h = (heroes || []).find(x => x.user_id === r.userId);
        return h && h.last_active_date === new Date().toISOString().split('T')[0];
      }).length;

      res.json({
        success: true,
        roster: roster.sort((a, b) => (b.xp || 0) - (a.xp || 0)),
        stats: {
          totalMembers: roster.length,
          totalXp,
          avgXp,
          activeToday,
        },
      });
    } catch (err) {
      console.error('[Hero] Team roster error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registerHeroRoutes, awardXP };
