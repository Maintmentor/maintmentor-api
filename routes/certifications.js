'use strict';

/**
 * routes/certifications.js
 *
 * Certification & Learning Platform API — Day 13
 *
 * Route prefix: /api/certifications  (registered in server.js)
 *
 * Public endpoints (no auth):
 *   GET  /tracks                              — list all certification tracks
 *
 * Authenticated endpoints (Supabase JWT required):
 *   GET  /tracks/:trackId/lessons             — list lessons for a track
 *   GET  /lessons/:lessonId                   — get full lesson content
 *   POST /lessons/:lessonId/complete          — mark lesson complete
 *   GET  /progress                            — get user's overall progress
 *   POST /lessons/:lessonId/quiz              — submit quiz answers
 *   POST /tracks/:trackId/certificate         — generate certificate (if eligible)
 */

const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { requireJWT } = require('../middleware/auth');

// ─── Helpers ───────────────────────────────────────────────────────────────────

function certNumber() {
  const year = new Date().getFullYear();
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `MM-${year}-${rand}`;
}

function handleError(res, err, context) {
  console.error(`[certifications] ${context}:`, err.message || err);
  return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
}

// ─── GET /tracks — Public ──────────────────────────────────────────────────────
/**
 * @swagger
 * /api/certifications/tracks:
 *   get:
 *     summary: List all certification tracks
 *     tags: [Certifications]
 *     responses:
 *       200:
 *         description: Array of certification tracks
 */
router.get('/tracks', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('certification_tracks')
      .select('id, name, slug, description, icon, difficulty_level, estimated_hours, created_at')
      .order('name');

    if (error) throw error;

    // Enrich each track with lesson count
    const tracksWithCounts = await Promise.all(
      (data || []).map(async (track) => {
        // Get all module ids for this track
        const { data: modules } = await supabase
          .from('certification_modules')
          .select('id')
          .eq('track_id', track.id);

        const moduleIds = (modules || []).map((m) => m.id);
        let lessonCount = 0;

        if (moduleIds.length > 0) {
          const { count } = await supabase
            .from('certification_lessons')
            .select('id', { count: 'exact', head: true })
            .in('module_id', moduleIds);
          lessonCount = count || 0;
        }

        return {
          ...track,
          lesson_count: lessonCount,
        };
      })
    );

    return res.json({ success: true, tracks: tracksWithCounts });
  } catch (err) {
    return handleError(res, err, 'GET /tracks');
  }
});

// ─── GET /tracks/:trackId/lessons — Auth required ─────────────────────────────
router.get('/tracks/:trackId/lessons', requireJWT, async (req, res) => {
  const { trackId } = req.params;

  try {
    // Verify track exists
    const { data: track, error: trackErr } = await supabase
      .from('certification_tracks')
      .select('id, name, slug')
      .eq('id', trackId)
      .maybeSingle();

    if (trackErr) throw trackErr;
    if (!track) return res.status(404).json({ success: false, error: 'Track not found' });

    // Get modules for this track
    const { data: modules, error: modErr } = await supabase
      .from('certification_modules')
      .select('id, name, description, order_index')
      .eq('track_id', trackId)
      .order('order_index');

    if (modErr) throw modErr;

    const moduleIds = (modules || []).map((m) => m.id);
    let lessons = [];

    if (moduleIds.length > 0) {
      const { data: lessonData, error: lessonErr } = await supabase
        .from('certification_lessons')
        .select('id, module_id, title, order_index, estimated_minutes, created_at')
        .in('module_id', moduleIds)
        .order('order_index');

      if (lessonErr) throw lessonErr;
      lessons = lessonData || [];
    }

    return res.json({ success: true, track, modules: modules || [], lessons });
  } catch (err) {
    return handleError(res, err, 'GET /tracks/:trackId/lessons');
  }
});

// ─── GET /lessons/:lessonId — Auth required ────────────────────────────────────
router.get('/lessons/:lessonId', requireJWT, async (req, res) => {
  const { lessonId } = req.params;

  try {
    const { data, error } = await supabase
      .from('certification_lessons')
      .select('*')
      .eq('id', lessonId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Lesson not found' });

    return res.json({ success: true, lesson: data });
  } catch (err) {
    return handleError(res, err, 'GET /lessons/:lessonId');
  }
});

// ─── POST /lessons/:lessonId/complete — Auth required ─────────────────────────
router.post('/lessons/:lessonId/complete', requireJWT, async (req, res) => {
  const { lessonId } = req.params;
  const userId = req.user.id;

  try {
    // Verify lesson exists and get track_id
    const { data: lesson, error: lessonErr } = await supabase
      .from('certification_lessons')
      .select('id, track_id, title')
      .eq('id', lessonId)
      .maybeSingle();

    if (lessonErr) throw lessonErr;
    if (!lesson) return res.status(404).json({ success: false, error: 'Lesson not found' });

    const now = new Date().toISOString();

    // Upsert into user_progress
    const { error: progressErr } = await supabase
      .from('user_progress')
      .upsert(
        {
          user_id: userId,
          lesson_id: lessonId,
          track_id: lesson.track_id,
          completed_at: now,
          passed: true,
        },
        { onConflict: 'user_id,lesson_id' }
      );

    if (progressErr) throw progressErr;

    // Also upsert into user_lesson_progress (for frontend compatibility)
    await supabase
      .from('user_lesson_progress')
      .upsert(
        {
          user_id: userId,
          lesson_id: lessonId,
          completed: true,
          completed_at: now,
        },
        { onConflict: 'user_id,lesson_id' }
      );

    return res.json({
      success: true,
      message: `Lesson "${lesson.title}" marked complete`,
      lesson_id: lessonId,
      completed_at: now,
    });
  } catch (err) {
    return handleError(res, err, 'POST /lessons/:lessonId/complete');
  }
});

// ─── GET /progress — Auth required ────────────────────────────────────────────
router.get('/progress', requireJWT, async (req, res) => {
  const userId = req.user.id;

  try {
    // Get all tracks
    const { data: tracks, error: tracksErr } = await supabase
      .from('certification_tracks')
      .select('id, name, slug, estimated_hours');

    if (tracksErr) throw tracksErr;

    // Get user's completed lessons
    const { data: completed, error: completedErr } = await supabase
      .from('user_progress')
      .select('lesson_id, track_id, completed_at, quiz_score, passed')
      .eq('user_id', userId);

    if (completedErr) throw completedErr;

    // Get user's certificates
    const { data: certs, error: certsErr } = await supabase
      .from('certificates')
      .select('track_id, certificate_number, issued_at')
      .eq('user_id', userId);

    if (certsErr) throw certsErr;

    // Build progress per track
    const completedByTrack = {};
    for (const row of completed || []) {
      if (!completedByTrack[row.track_id]) completedByTrack[row.track_id] = [];
      completedByTrack[row.track_id].push(row);
    }

    const certsByTrack = {};
    for (const cert of certs || []) {
      certsByTrack[cert.track_id] = cert;
    }

    const progress = await Promise.all(
      (tracks || []).map(async (track) => {
        // Count total lessons for this track
        const { data: modules } = await supabase
          .from('certification_modules')
          .select('id')
          .eq('track_id', track.id);

        const moduleIds = (modules || []).map((m) => m.id);
        let totalLessons = 0;

        if (moduleIds.length > 0) {
          const { count } = await supabase
            .from('certification_lessons')
            .select('id', { count: 'exact', head: true })
            .in('module_id', moduleIds);
          totalLessons = count || 0;
        }

        const trackCompleted = completedByTrack[track.id] || [];
        const completedLessons = trackCompleted.length;
        const percentage = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;

        return {
          track_id: track.id,
          track_name: track.name,
          track_slug: track.slug,
          total_lessons: totalLessons,
          completed_lessons: completedLessons,
          percentage,
          certificate: certsByTrack[track.id] || null,
        };
      })
    );

    const totalCompleted = (completed || []).length;
    const totalCerts = (certs || []).length;

    return res.json({
      success: true,
      user_id: userId,
      summary: {
        total_lessons_completed: totalCompleted,
        certificates_earned: totalCerts,
      },
      tracks: progress,
    });
  } catch (err) {
    return handleError(res, err, 'GET /progress');
  }
});

// ─── POST /lessons/:lessonId/quiz — Auth required ─────────────────────────────
router.post('/lessons/:lessonId/quiz', requireJWT, async (req, res) => {
  const { lessonId } = req.params;
  const userId = req.user.id;
  const { answers } = req.body; // Array of { questionId, answer }

  // Validate input
  if (!answers || !Array.isArray(answers)) {
    return res.status(400).json({
      success: false,
      error: 'answers must be an array of { questionId, answer }',
    });
  }

  try {
    // Get lesson to find module
    const { data: lesson, error: lessonErr } = await supabase
      .from('certification_lessons')
      .select('id, module_id, track_id, title')
      .eq('id', lessonId)
      .maybeSingle();

    if (lessonErr) throw lessonErr;
    if (!lesson) return res.status(404).json({ success: false, error: 'Lesson not found' });

    // Find quiz for this module
    const { data: quiz, error: quizErr } = await supabase
      .from('certification_quizzes')
      .select('id, title, passing_score')
      .eq('module_id', lesson.module_id)
      .maybeSingle();

    if (quizErr) throw quizErr;
    if (!quiz) {
      return res.status(404).json({
        success: false,
        error: 'No quiz found for this lesson\'s module',
      });
    }

    // Get questions for the quiz
    const { data: questions, error: questionsErr } = await supabase
      .from('certification_questions')
      .select('id, question_text, correct_answer, explanation, options')
      .eq('quiz_id', quiz.id);

    if (questionsErr) throw questionsErr;
    if (!questions || questions.length === 0) {
      return res.status(404).json({ success: false, error: 'No questions found for this quiz' });
    }

    // Score the answers
    const questionMap = {};
    for (const q of questions) {
      questionMap[q.id] = q;
    }

    let correct = 0;
    const results = answers.map((a) => {
      const q = questionMap[a.questionId];
      if (!q) return { questionId: a.questionId, correct: false, error: 'Question not found' };

      const isCorrect = String(a.answer).toLowerCase() === String(q.correct_answer).toLowerCase();
      if (isCorrect) correct++;

      return {
        questionId: a.questionId,
        submitted: a.answer,
        correct_answer: q.correct_answer,
        is_correct: isCorrect,
        explanation: q.explanation,
      };
    });

    const total = questions.length;
    const score = total > 0 ? Math.round((correct / total) * 100) : 0;
    const passed = score >= quiz.passing_score;

    // Store quiz attempt
    const now = new Date().toISOString();
    await supabase.from('user_quiz_attempts').insert({
      user_id: userId,
      quiz_id: quiz.id,
      score,
      passed,
      answers: Object.fromEntries(answers.map((a) => [a.questionId, a.answer])),
      started_at: now,
      completed_at: now,
    });

    // If passed, also update user_progress with quiz score
    if (passed) {
      await supabase
        .from('user_progress')
        .upsert(
          {
            user_id: userId,
            lesson_id: lessonId,
            track_id: lesson.track_id,
            completed_at: now,
            quiz_score: score,
            passed: true,
          },
          { onConflict: 'user_id,lesson_id' }
        );
    }

    return res.json({
      success: true,
      quiz_id: quiz.id,
      quiz_title: quiz.title,
      score,
      passing_score: quiz.passing_score,
      passed,
      correct_count: correct,
      total_questions: total,
      results,
    });
  } catch (err) {
    return handleError(res, err, 'POST /lessons/:lessonId/quiz');
  }
});

// ─── POST /tracks/:trackId/certificate — Auth required ────────────────────────
router.post('/tracks/:trackId/certificate', requireJWT, async (req, res) => {
  const { trackId } = req.params;
  const userId = req.user.id;

  try {
    // Get track
    const { data: track, error: trackErr } = await supabase
      .from('certification_tracks')
      .select('id, name, slug')
      .eq('id', trackId)
      .maybeSingle();

    if (trackErr) throw trackErr;
    if (!track) return res.status(404).json({ success: false, error: 'Track not found' });

    // Check if cert already issued
    const { data: existing } = await supabase
      .from('certificates')
      .select('*')
      .eq('user_id', userId)
      .eq('track_id', trackId)
      .maybeSingle();

    if (existing) {
      // Get user profile for name
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, email')
        .eq('id', userId)
        .maybeSingle();

      return res.json({
        success: true,
        already_issued: true,
        certificate: {
          id: existing.id,
          user_name: profile?.full_name || profile?.email || 'MaintMentor Student',
          track_name: track.name,
          issued_at: existing.issued_at,
          certificate_number: existing.certificate_number,
        },
      });
    }

    // Get all modules for this track
    const { data: modules, error: modErr } = await supabase
      .from('certification_modules')
      .select('id')
      .eq('track_id', trackId);

    if (modErr) throw modErr;

    const moduleIds = (modules || []).map((m) => m.id);

    if (moduleIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No lessons found for this track',
      });
    }

    // Get all lessons for this track
    const { data: lessons, error: lessonsErr } = await supabase
      .from('certification_lessons')
      .select('id')
      .in('module_id', moduleIds);

    if (lessonsErr) throw lessonsErr;

    if (!lessons || lessons.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No lessons found for this track',
      });
    }

    const lessonIds = lessons.map((l) => l.id);

    // Check user progress — all lessons must be completed
    const { data: progress, error: progressErr } = await supabase
      .from('user_progress')
      .select('lesson_id, passed')
      .eq('user_id', userId)
      .eq('track_id', trackId)
      .in('lesson_id', lessonIds);

    if (progressErr) throw progressErr;

    const completedIds = new Set((progress || []).filter((p) => p.passed).map((p) => p.lesson_id));
    const incomplete = lessonIds.filter((id) => !completedIds.has(id));

    if (incomplete.length > 0) {
      return res.status(400).json({
        success: false,
        error: `You must complete all lessons before earning this certificate. ${incomplete.length} lesson(s) remaining.`,
        completed: completedIds.size,
        total: lessonIds.length,
        remaining: incomplete.length,
      });
    }

    // All lessons complete — issue certificate
    const certNumber = certNumber_generate();
    const now = new Date().toISOString();

    const { data: cert, error: certErr } = await supabase
      .from('certificates')
      .insert({
        user_id: userId,
        track_id: trackId,
        certificate_number: certNumber,
        issued_at: now,
      })
      .select()
      .single();

    if (certErr) throw certErr;

    // Get user profile for name
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', userId)
      .maybeSingle();

    return res.status(201).json({
      success: true,
      already_issued: false,
      certificate: {
        id: cert.id,
        user_name: profile?.full_name || profile?.email || 'MaintMentor Student',
        track_name: track.name,
        issued_at: cert.issued_at,
        certificate_number: cert.certificate_number,
      },
    });
  } catch (err) {
    return handleError(res, err, 'POST /tracks/:trackId/certificate');
  }
});

// Helper: generate certificate number (MM-YEAR-XXXX)
function certNumber_generate() {
  const year = new Date().getFullYear();
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `MM-${year}-${rand}`;
}

module.exports = router;
