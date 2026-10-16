/**
 * TalentBridge Agency email notifications via a free Gmail account.
 * Keep TALENTBRIDGE_SHARED_SECRET in Apps Script Project Settings > Script Properties.
 * Deploy as a web app executing as your account. The recipient is fixed intentionally.
 */
const ALERT_RECIPIENT = 'easytiger.business@gmail.com';
const SECRET_PROPERTY = 'TALENTBRIDGE_SHARED_SECRET';

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '{}');
  } catch (error) {
    return jsonOutput({ ok: false, error: 'invalid_json' });
  }

  const expected = PropertiesService.getScriptProperties().getProperty(SECRET_PROPERTY) || '';
  const supplied = typeof payload.secret === 'string' ? payload.secret : '';
  if (!expected || !constantTimeEquals(supplied, expected)) {
    return jsonOutput({ ok: false, error: 'unauthorized' });
  }
  if (payload.to !== ALERT_RECIPIENT) {
    return jsonOutput({ ok: false, error: 'recipient_not_allowed' });
  }

  const subject = typeof payload.subject === 'string' ? payload.subject.slice(0, 180) : '';
  const body = typeof payload.text === 'string' ? payload.text.slice(0, 15000) : '';
  const html = typeof payload.html === 'string' ? payload.html.slice(0, 30000) : '';
  if (!subject || !body) return jsonOutput({ ok: false, error: 'invalid_message' });

  try {
    MailApp.sendEmail({
      to: ALERT_RECIPIENT,
      subject: subject,
      body: body,
      htmlBody: html || undefined,
      name: 'TalentBridge Agency'
    });
    return jsonOutput({ ok: true });
  } catch (error) {
    return jsonOutput({ ok: false, error: 'send_failed' });
  }
}

function setupAuthorization() {
  const quota = MailApp.getRemainingDailyQuota();
  Logger.log('Mail sending authorization is active. Remaining recipient quota: ' + quota);
}

function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function jsonOutput(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
