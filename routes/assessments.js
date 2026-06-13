'use strict';

/**
 * routes/assessments.js
 *
 * Includes public translation endpoint so guest/candidate pages can translate
 * quiz content without requiring a login session.
 *
 * Public (no auth) guest quiz endpoints for candidate screening.
 * Property managers share a link; candidates take the quiz without an account.
 *
 * Routes:
 *   GET  /api/assessments/quiz/:quizId          — quiz metadata + questions (public)
 *   POST /api/assessments/quiz/:quizId/submit   — submit answers, save result (public)
 *   GET  /api/assessments/result/:resultId      — fetch a saved result by ID (public)
 *   GET  /api/assessments/list                  — list available quizzes for sharing (public)
 */

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

// ─── GET /api/assessments/quiz/:quizId — public ──────────────────────────────
router.get('/quiz/:quizId', async (req, res) => {
  try {
    const { quizId } = req.params;

    const { data: quiz, error: quizErr } = await supabase
      .from('certification_quizzes')
      .select('id, title, passing_score, time_limit_minutes, module_id')
      .eq('id', quizId)
      .single();

    if (quizErr || !quiz) {
      return res.status(404).json({ success: false, error: 'Quiz not found' });
    }

    // Get questions (no correct_answer exposed — scored server-side)
    const { data: questions, error: qErr } = await supabase
      .from('certification_questions')
      .select('id, question_text, question_type, options, difficulty')
      .eq('quiz_id', quizId)
      .order('id');

    if (qErr) throw qErr;

    // Get module/track context
    const { data: module } = await supabase
      .from('certification_modules')
      .select('id, name, track_id')
      .eq('id', quiz.module_id)
      .single();

    let trackName = null;
    if (module?.track_id) {
      const { data: track } = await supabase
        .from('certification_tracks')
        .select('name, slug')
        .eq('id', module.track_id)
        .single();
      trackName = track?.name || null;
    }

    res.json({
      success: true,
      quiz: {
        id:               quiz.id,
        title:            quiz.title,
        passingScore:     quiz.passing_score,
        timeLimitMinutes: quiz.time_limit_minutes,
        moduleName:       module?.name || null,
        trackName,
      },
      questions: (questions || []).map((q) => ({
        id:           q.id,
        questionText: q.question_text,
        questionType: q.question_type,
        options:      q.options,
        difficulty:   q.difficulty,
      })),
    });
  } catch (err) {
    console.error('[assessments] GET /quiz/:quizId error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load quiz' });
  }
});

// ─── GET /api/assessments/quiz/:quizId/preview — auth required, shows correct answers ───
const { createClient: createAuthClient } = require('@supabase/supabase-js');
const authClient = createClient(
  process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

router.get('/quiz/:quizId/preview', async (req, res) => {
  try {
    const { quizId } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = authHeader.slice(7);
    const { data: { user }, error: authErr } = await authClient.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { data: quiz, error: quizErr } = await supabase
      .from('certification_quizzes')
      .select('id, title, passing_score, time_limit_minutes, module_id')
      .eq('id', quizId)
      .single();
    if (quizErr || !quiz) return res.status(404).json({ success: false, error: 'Quiz not found' });

    // Include correct_answer and explanation for preview
    const { data: questions, error: qErr } = await supabase
      .from('certification_questions')
      .select('id, question_text, question_type, options, difficulty, correct_answer, explanation')
      .eq('quiz_id', quizId)
      .order('id');
    if (qErr) throw qErr;

    const { data: module } = await supabase
      .from('certification_modules')
      .select('id, name, track_id')
      .eq('id', quiz.module_id)
      .single();

    let trackName = null;
    if (module?.track_id) {
      const { data: track } = await supabase
        .from('certification_tracks')
        .select('name, slug')
        .eq('id', module.track_id)
        .single();
      trackName = track?.name || null;
    }

    res.json({
      success: true,
      quiz: {
        id: quiz.id, title: quiz.title, passingScore: quiz.passing_score,
        timeLimitMinutes: quiz.time_limit_minutes, moduleName: module?.name || null, trackName,
      },
      questions: (questions || []).map((q) => ({
        id: q.id, questionText: q.question_text, questionType: q.question_type,
        options: q.options, difficulty: q.difficulty,
        correctAnswer: q.correct_answer, explanation: q.explanation || null,
      })),
    });
  } catch (err) {
    console.error('[assessments] GET /quiz/:quizId/preview error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load preview' });
  }
});

// ─── POST /api/assessments/quiz/:quizId/submit — public ─────────────────────
router.post('/quiz/:quizId/submit', async (req, res) => {
  try {
    const { quizId } = req.params;
    const { candidateName, answers, integrity } = req.body;
    // integrity: { tabSwitches, completionSeconds, timingsPerQuestion: { [questionId]: seconds } }

    if (!candidateName || typeof candidateName !== 'string' || !candidateName.trim()) {
      return res.status(400).json({ success: false, error: 'candidateName is required' });
    }
    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ success: false, error: 'answers object is required' });
    }

    // Load quiz
    const { data: quiz, error: quizErr } = await supabase
      .from('certification_quizzes')
      .select('id, title, passing_score')
      .eq('id', quizId)
      .single();

    if (quizErr || !quiz) {
      return res.status(404).json({ success: false, error: 'Quiz not found' });
    }

    // Load questions with correct answers (server-side only)
    const { data: questions, error: qErr } = await supabase
      .from('certification_questions')
      .select('id, question_text, correct_answer, options, explanation')
      .eq('quiz_id', quizId);

    if (qErr) throw qErr;
    if (!questions || questions.length === 0) {
      return res.status(404).json({ success: false, error: 'No questions found' });
    }

    // Score
    let correct = 0;
    const review = questions.map((q) => {
      const given = answers[q.id];
      const isCorrect = given === q.correct_answer;
      if (isCorrect) correct++;
      return {
        questionId:    q.id,
        questionText:  q.question_text,
        givenAnswer:   given ?? null,
        correctAnswer: q.correct_answer,
        isCorrect,
        explanation:   q.explanation || null,
        options:       q.options,
      };
    });

    const total   = questions.length;
    const score   = Math.round((correct / total) * 100);
    const passed  = score >= quiz.passing_score;

    // ── Integrity analysis ───────────────────────────────────────────────────
    const integrityFlags = [];
    let integrityScore = 'clean';

    const tabSwitches       = parseInt(integrity?.tabSwitches       || 0);
    const completionSeconds = parseInt(integrity?.completionSeconds || 0);
    const timings           = integrity?.timingsPerQuestion || {};
    const timingValues      = Object.values(timings).map(Number).filter((t) => t > 0);
    const avgSecondsPerQ    = timingValues.length
      ? Math.round((timingValues.reduce((a, b) => a + b, 0) / timingValues.length) * 10) / 10
      : null;

    // Flag: too many tab switches
    if (tabSwitches >= 3) {
      integrityFlags.push({ code: 'TAB_SWITCHES', detail: `Left quiz tab ${tabSwitches} time(s)` });
    }
    // Flag: suspiciously fast (avg < 6 seconds per question)
    if (avgSecondsPerQ !== null && avgSecondsPerQ < 6) {
      integrityFlags.push({ code: 'FAST_ANSWERS', detail: `Avg ${avgSecondsPerQ}s per question (under 6s threshold)` });
    }
    // Flag: entire quiz done impossibly fast (< 30 seconds for whole thing)
    if (completionSeconds > 0 && completionSeconds < 30) {
      integrityFlags.push({ code: 'FAST_COMPLETION', detail: `Completed in ${completionSeconds}s` });
    }

    if (integrityFlags.length >= 2) integrityScore = 'flagged';
    else if (integrityFlags.length === 1) integrityScore = 'review';

    // Save result
    const { data: result, error: saveErr } = await supabase
      .from('assessment_results')
      .insert({
        quiz_id:                  quizId,
        candidate_name:           candidateName.trim(),
        score,
        passed,
        answers,
        total_questions:          total,
        correct_answers:          correct,
        tab_switches:             tabSwitches,
        completion_seconds:       completionSeconds || null,
        avg_seconds_per_question: avgSecondsPerQ,
        integrity_flags:          integrityFlags,
        integrity_score:          integrityScore,
      })
      .select('id, taken_at')
      .single();

    if (saveErr) throw saveErr;

    res.json({
      success: true,
      resultId:       result.id,
      score,
      passed,
      passingScore:   quiz.passing_score,
      correct,
      total,
      takenAt:        result.taken_at,
      candidateName:  candidateName.trim(),
      quizTitle:      quiz.title,
      review,
      integrity: {
        score:          integrityScore,
        flags:          integrityFlags,
        tabSwitches,
        completionSeconds: completionSeconds || null,
        avgSecondsPerQuestion: avgSecondsPerQ,
      },
    });
  } catch (err) {
    console.error('[assessments] POST /quiz/:quizId/submit error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to submit quiz' });
  }
});

// ─── GET /api/assessments/result/:resultId — public ─────────────────────────
router.get('/result/:resultId', async (req, res) => {
  try {
    const { resultId } = req.params;

    const { data: result, error } = await supabase
      .from('assessment_results')
      .select('id, quiz_id, candidate_name, score, passed, total_questions, correct_answers, taken_at, tab_switches, completion_seconds, avg_seconds_per_question, integrity_flags, integrity_score')
      .eq('id', resultId)
      .single();

    if (error || !result) {
      return res.status(404).json({ success: false, error: 'Result not found' });
    }

    const { data: quiz } = await supabase
      .from('certification_quizzes')
      .select('title, passing_score')
      .eq('id', result.quiz_id)
      .single();

    res.json({
      success:       true,
      resultId:      result.id,
      candidateName: result.candidate_name,
      score:         result.score,
      passed:        result.passed,
      correct:       result.correct_answers,
      total:         result.total_questions,
      takenAt:       result.taken_at,
      quizTitle:     quiz?.title || 'Assessment',
      passingScore:  quiz?.passing_score || 70,
      integrity: {
        score:                result.integrity_score || 'clean',
        flags:                result.integrity_flags || [],
        tabSwitches:          result.tab_switches || 0,
        completionSeconds:    result.completion_seconds,
        avgSecondsPerQuestion: result.avg_seconds_per_question,
      },
    });
  } catch (err) {
    console.error('[assessments] GET /result/:resultId error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch result' });
  }
});

// ─── GET /api/assessments/list — available quizzes for sharing ───────────────
// --- GET /api/assessments/org/:orgId --- public org name lookup
router.get('/org/:orgId', async (req, res) => {
  try {
    const { data: org, error } = await supabase
      .from('organizations')
      .select('id, name')
      .eq('id', req.params.orgId)
      .single();
    if (error || !org) return res.status(404).json({ success: false, error: 'Org not found' });
    res.json({ success: true, org: { id: org.id, name: org.name } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch org' });
  }
});

// --- POST /api/assessments/org/:orgId/join --- auto-join org after signup
router.post('/org/:orgId/join', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer '))
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.slice(7);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { orgId } = req.params;
    const { data: org, error: orgErr } = await supabase
      .from('organizations').select('id, name').eq('id', orgId).single();
    if (orgErr || !org) return res.status(404).json({ success: false, error: 'Organization not found' });

    const { data: existing } = await supabase.from('organization_members')
      .select('id, status').eq('org_id', orgId).eq('user_id', user.id).maybeSingle();
    if (existing) return res.json({ success: true, alreadyMember: true, orgName: org.name });

    const { data: emailMatch } = await supabase.from('organization_members')
      .select('id').eq('org_id', orgId).eq('invited_email', user.email).maybeSingle();
    if (emailMatch) {
      await supabase.from('organization_members')
        .update({ user_id: user.id, status: 'active', joined_at: new Date().toISOString() })
        .eq('id', emailMatch.id);
    } else {
      await supabase.from('organization_members').insert({
        org_id: orgId, user_id: user.id, role: 'member', status: 'active',
        invited_email: user.email, joined_at: new Date().toISOString(),
      });
    }
    res.json({ success: true, joined: true, orgName: org.name });
  } catch (err) {
    console.error('[assessments] POST /org/:orgId/join error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to join org' });
  }
});

router.get('/list', async (req, res) => {
  try {
    const { data: quizzes, error } = await supabase
      .from('certification_quizzes')
      .select('id, title, passing_score, time_limit_minutes, module_id');

    if (error) throw error;

    const moduleIds = [...new Set(quizzes.map((q) => q.module_id))];
    const { data: modules } = await supabase
      .from('certification_modules')
      .select('id, name, track_id')
      .in('id', moduleIds);

    const trackIds = [...new Set((modules || []).map((m) => m.track_id))];
    const { data: tracks } = await supabase
      .from('certification_tracks')
      .select('id, name, slug')
      .in('id', trackIds);

    const moduleMap = Object.fromEntries((modules || []).map((m) => [m.id, m]));
    const trackMap  = Object.fromEntries((tracks  || []).map((t) => [t.id, t]));

    const list = (quizzes || []).map((q) => {
      const mod   = moduleMap[q.module_id] || {};
      const track = trackMap[mod.track_id]  || {};
      return {
        quizId:           q.id,
        title:            q.title,
        passingScore:     q.passing_score,
        timeLimitMinutes: q.time_limit_minutes,
        moduleName:       mod.name || null,
        trackName:        track.name || null,
        assessmentUrl:    `https://maintmentor.ai/assessment/${q.id}`,
      };
    });

    res.json({ success: true, quizzes: list });
  } catch (err) {
    console.error('[assessments] GET /list error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to list assessments' });
  }
});

// ─── POST /api/assessments/translate — public (no auth) ────────────────────
// Rate-limited by IP to prevent abuse: max 30 req/min per IP
const translateHits = new Map(); // ip -> { count, resetAt }

router.post('/translate', async (req, res) => {
  try {
    // Simple in-memory rate limit (30 req/min per IP)
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown';
    const now = Date.now();
    const hit = translateHits.get(ip) || { count: 0, resetAt: now + 60_000 };
    if (now > hit.resetAt) { hit.count = 0; hit.resetAt = now + 60_000; }
    hit.count++;
    translateHits.set(ip, hit);
    if (hit.count > 30) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded. Try again in a minute.' });
    }

    const { content, targetLanguage } = req.body;
    if (!content || !targetLanguage) {
      return res.status(400).json({ success: false, error: 'content and targetLanguage are required' });
    }

    // Skip if English
    if (targetLanguage.startsWith('en')) {
      return res.json({ success: true, translated: content });
    }

    // Lazy-load Gemini (same key as main server)
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ success: false, error: 'Translation service unavailable' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `You are a professional technical translator specializing in residential maintenance and building trades.
Translate the following JSON content into the language identified by locale code "${targetLanguage}".
Preserve all JSON keys exactly as-is. Only translate the string values.
Maintain technical accuracy — use proper maintenance and trades terminology in the target language.
Return ONLY valid JSON with no additional text or markdown.

Content to translate:
${JSON.stringify(content, null, 2)}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

    let translated;
    try {
      translated = JSON.parse(cleaned);
    } catch {
      return res.json({ success: true, translated: content, warning: 'Parse failed, returning original' });
    }

    return res.json({ success: true, translated });
  } catch (err) {
    console.error('[assessments/translate] error:', err.message);
    res.status(500).json({ success: false, error: 'Translation failed' });
  }
});

module.exports = router;
