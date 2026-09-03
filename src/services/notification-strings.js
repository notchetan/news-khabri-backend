// The only user-facing string the backend sends: the trending-story push
// notification title. The body is the story headline, already in the
// subscription's language, so the title has to match it. Keyed by the same
// language codes push_subscriptions.language uses (the frontend's i18n
// locale codes). Unknown / missing -> English.
const TRENDING_TITLE = {
  en: 'Trending now',
  hi: 'अभी ट्रेंडिंग',
  gu: 'અત્યારે ટ્રેન્ડિંગ',
  bn: 'এখন ট্রেন্ডিং',
  kn: 'ಈಗ ಟ್ರೆಂಡಿಂಗ್',
  ml: 'ഇപ്പോൾ ട്രെൻഡിംഗ്',
  mr: 'आत्ता ट्रेंडिंग',
  or: 'ବର୍ତ୍ତମାନ ଟ୍ରେଣ୍ଡିଂ',
  ta: 'இப்போது டிரெண்டிங்',
  te: 'ఇప్పుడు ట్రెండింగ్',
};

function trendingTitle(language) {
  return TRENDING_TITLE[language] || TRENDING_TITLE.en;
}

module.exports = { trendingTitle };
