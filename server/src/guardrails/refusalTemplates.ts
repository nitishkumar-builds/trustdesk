/**
 * Deterministic, customer-safe refusal bodies. No model call is needed to refuse. Each template:
 * 3–5 sentences, apologetic, states what happens next (a human specialist reviews), never repeats
 * the injected instruction back, and never mentions that internal instructions or prompts exist
 * beyond declining. None of them contain the phrases the output scanner flags.
 */

export type RefusalTemplateKey =
  | 'secret_disclosure_request'
  | 'identity_bypass_request'
  | 'injection_coupon_request'
  | 'unsupported_policy_request';

export const REFUSAL_TEMPLATES: Readonly<Record<RefusalTemplateKey, string>> = Object.freeze({
  secret_disclosure_request: [
    'Thank you for reaching out, and I am sorry I cannot help with this particular request.',
    'For security reasons we are unable to share any internal configuration, credentials, or internal notes with anyone, including our customers.',
    'I have passed your message to a human support specialist who will review it and follow up with you directly.',
    'If there is an order or account issue I can help with in the meantime, please let me know.',
  ].join(' '),

  identity_bypass_request: [
    'Thank you for contacting us, and I am sorry for the inconvenience.',
    'To protect your account, changes to account details always require identity verification, and this step cannot be skipped by anyone on the support team.',
    'A human support specialist will review your request and contact you with the verification steps.',
    'Once verification is complete, they will be able to make the change you asked for.',
  ].join(' '),

  injection_coupon_request: [
    'Thank you for your message, and I am sorry I am not able to act on it as written.',
    'Goodwill credits and coupons can only be issued by a member of our support team, in line with our support policy and with a reviewer\'s approval.',
    'I have escalated your ticket to a human support specialist who will look into your situation and respond to you directly.',
    'If you have a specific problem with an order, please share the details and we will do our best to help.',
  ].join(' '),

  unsupported_policy_request: [
    'Thank you for getting in touch, and I am sorry for any frustration this has caused.',
    'I am not able to confirm what you are asking for from our current policy, so I do not want to give you an answer that might turn out to be wrong.',
    'I have passed your ticket to a human support specialist who will review the details and follow up with a definitive answer.',
    'We appreciate your patience while they look into it.',
  ].join(' '),
});

export function refusalBody(key: RefusalTemplateKey): string {
  return REFUSAL_TEMPLATES[key];
}
