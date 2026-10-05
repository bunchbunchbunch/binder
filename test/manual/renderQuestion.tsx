// Run with FORCE_COLOR=3 when piping to a file, or Ink drops its colors.
// Render the question picker to ANSI for a visual check.
import React from 'react';
import { Box, renderToString } from 'ink';
import { QuestionView } from '../../src/ui/QuestionView.js';

const q = {
  requestId: 'r', toolUseId: 't',
  questions: [{
    question: 'Which database should the service use?', header: 'Database', multiSelect: false,
    options: [
      { label: 'Postgres (Recommended)', description: 'Relational, strong tooling, already in the stack' },
      { label: 'SQLite', description: 'Zero ops, single file, fine for one user' },
      { label: 'DynamoDB', description: 'Serverless, pay per request' },
    ],
  }],
};
process.stdout.write(renderToString(<Box width={100}><QuestionView question={q} onAnswer={() => {}} /></Box>, { columns: 100 }) + '\n');
