'use strict';
/**
 * Chat route — SSE streaming endpoint for the Migration Intelligence Agent
 * POST /api/chat  { question: string, projectId?: string|number }
 */

const express = require('express');
const { streamChatResponse } = require('../services/chat-agent');

const router = express.Router();

router.post('/', async (req, res) => {
  const { question, projectId } = req.body || {};

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ error: 'question is required' });
  }

  // SSE headers — X-Accel-Buffering: no is critical for Azure App Service / nginx proxies
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  await streamChatResponse(question.trim(), projectId || null, res);
});

module.exports = router;
