-- Assessment Results table for guest/candidate quiz feature
CREATE TABLE IF NOT EXISTS assessment_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id UUID NOT NULL REFERENCES certification_quizzes(id),
  candidate_name TEXT NOT NULL,
  score INTEGER NOT NULL,
  passed BOOLEAN NOT NULL,
  answers JSONB,
  total_questions INTEGER NOT NULL,
  correct_answers INTEGER NOT NULL,
  taken_at TIMESTAMPTZ DEFAULT NOW(),
  -- Integrity tracking
  tab_switches INTEGER DEFAULT 0,
  completion_seconds INTEGER,
  avg_seconds_per_question NUMERIC(6,1),
  integrity_flags JSONB DEFAULT '[]',
  integrity_score TEXT DEFAULT 'clean'  -- 'clean' | 'review' | 'flagged'
);

CREATE INDEX IF NOT EXISTS idx_assessment_results_quiz_id ON assessment_results(quiz_id);
CREATE INDEX IF NOT EXISTS idx_assessment_results_taken_at ON assessment_results(taken_at DESC);
