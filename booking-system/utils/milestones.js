'use strict';

// Milestone definitions — visit number → reward
const MILESTONES = [
  { visits: 1,  label_en: 'Welcome to the family', label_nl: 'Welkom bij de familie', reward_en: 'So glad you\'re here. See you again soon!', reward_nl: 'Wat fijn dat je er bent. Tot snel!', emoji: '🌿' },
  { visits: 5,  label_en: 'Regular',            label_nl: 'Vaste gast',       reward_en: 'Bring a friend for free — once. Use this code when booking for 2.',  reward_nl: 'Neem 1x een vriend gratis mee. Gebruik deze code bij een boeking voor 2.', emoji: '🔥', code_prefix: 'VRIEND' },
  { visits: 10, label_en: 'Loyal Visitor',      label_nl: 'Loyale bezoeker',  reward_en: 'A free Soki sauna hat — pick it up at the front desk on your next visit!', reward_nl: 'Een gratis Soki sauna hat — haal hem op bij de balie bij je volgende bezoek!', emoji: '⭐', code_prefix: 'HAT' },
  { visits: 25, label_en: 'Soki Regular',       label_nl: 'Soki Stamgast',    reward_en: 'A free session — our gift to you.',                        reward_nl: 'Een gratis sessie — ons cadeau aan jou.',                    emoji: '💎', code_prefix: 'STAM' },
  { visits: 50, label_en: 'Soki Legend',        label_nl: 'Soki Legende',     reward_en: 'VIP status — contact us for your exclusive reward.',        reward_nl: 'VIP-status — neem contact met ons op voor je exclusieve beloning.', emoji: '🏆', code_prefix: 'LEGEND' },
];

function getMilestoneForVisit(visitCount) {
  return MILESTONES.find(m => m.visits === visitCount) || null;
}

function generatePromoCode(prefix, userId) {
  return prefix + userId + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function getNextMilestone(visitCount) {
  return MILESTONES.find(m => m.visits > visitCount) || null;
}

module.exports = { MILESTONES, getMilestoneForVisit, generatePromoCode, getNextMilestone };
