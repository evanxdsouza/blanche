// Links into the YSWS Project Submission Guidelines
// (https://hackclub.gitbook.io/ysws-project-submission-guidelines/).
// Every rule in rules.js cites one of these so the reviewer can check the source.
const BASE = 'https://hackclub.gitbook.io/ysws-project-submission-guidelines/BLBRN8LIfoCZhFV6oMNR';

const page = (slug, title) => (anchor, section) => ({
  title: section ? `${title}: ${section}` : title,
  url: `${BASE}/${slug}${anchor ? '#' + anchor : ''}`,
});

const fields = page('required-submission-fields', 'Required Submission Fields');
const shipped = page('what-makes-a-project-shipped', 'What Makes a Project "Shipped"?');
const hours = page('override-hours-spent', 'Override Hours Spent');
const dupes = page('duplicate-and-updated-submissions', 'Duplicate and Updated Submissions');
const exceptions = page('project-exceptions', 'Project Exceptions');
const spot = page('spot-checks', 'Spot-Checks');

module.exports = {
  BASE,
  HOME: 'https://hackclub.gitbook.io/ysws-project-submission-guidelines',
  playableUrl: fields('playable-url', 'Playable URL'),
  codeUrl: fields('code-url', 'Code URL'),
  screenshot: fields('screenshot', 'Screenshot'),
  description: fields('description', 'Description'),
  reproducibility: fields('reproducibility', 'Reproducibility'),
  universal: shipped('', 'Universal Ship Requirements'),
  desktop: shipped('desktop-apps', 'Desktop Apps'),
  games: shipped('games', 'Games'),
  websites: shipped('websites-web-apps', 'Websites/Web Apps'),
  disallowedHosts: shipped('disallowed-hosts-and-what-to-use-instead', 'Disallowed Hosts'),
  inflated: hours('reason-for-deflation-1-inflated-hours', 'Inflated Hours'),
  ai: hours('reason-for-deflation-2-ai-generated-code', 'AI-Generated Code'),
  fraud: hours('outright-fraud', 'Outright Fraud'),
  duplicates: dupes('', ''),
  school: exceptions('school-assignments', 'School Assignments'),
  hackathons: exceptions('external-hackathons', 'External Hackathons'),
  spotChecks: spot('', ''),
};
