// Every tunable knob for Stage 1 ranking lives here so the scoring logic in
// ranking.js never hardcodes a number. See docs/ranking-tuning.md for the
// calibration history behind each value below.

// The divisor in exp(-ageInHours / FRESHNESS_DECAY_HOURS).
const FRESHNESS_DECAY_HOURS = 12;

// Must stay roughly summing to 1 - see docs/ranking-tuning.md.
const RANKING_WEIGHTS = {
  importance: 0.5,
  freshness: 0.25,
  sourceAuthority: 0.25,
};

// Add an entry here for each new source as it's onboarded; anything
// missing falls back to DEFAULT_SOURCE_AUTHORITY. See docs/ranking-tuning.md.
const SOURCE_AUTHORITY = {
  'Times of India': 0.8,
  'The Hindu': 0.9,
  'Economic Times': 0.85,
  'Indian Express': 0.8,
  NDTV: 0.8,
  'NDTV Khabar': 0.75,
  'Aaj Tak': 0.7,
  'Amar Ujala': 0.65,
  'Dainik Bhaskar': 0.65,
  'Divya Bhaskar': 0.65,
};
const DEFAULT_SOURCE_AUTHORITY = 0.5;

// Rule-based importance signal - every article starts at IMPORTANCE_BASELINE
// and each matching keyword nudges the score up or down. See
// docs/ranking-tuning.md.
const IMPORTANCE_BASELINE = 0.5;

// One boost/penalize keyword list per supported language (same set
// computeImportance's article.language already resolves against, mirroring
// category-aliases.js's per-language pattern) - previously this was a
// single English-only list, which meant a Hindi/Gujarati/etc. article could
// never match anything and always fell back to IMPORTANCE_BASELINE
// regardless of how newsworthy it actually was, while English articles got
// real differentiation. Each language keeps the same category groupings as
// the original English list (political, war, disaster, economic,
// corporate, tech, sports, deaths) so the calibration behind each stays
// legible - see docs/ranking-tuning.md. Institutional acronyms (RBI, GDP,
// IPO, CEO, AI) stay in Latin script in every language's list, matching how
// they actually appear in real regional-language news text.
//
// DRAFT machine-assisted translations for hi/gu/bn/kn/mr/ml/ta/te/or, not
// reviewed by native speakers - same caveat as the frontend's own
// bn/kn/mr/ml/ta/te/or locale files (see news-khabri's src/i18n/locales/bn.ts).
// Needs native review before being treated as production-quality tuning,
// same as the English list's own calibration history in docs/ranking-tuning.md.
const IMPORTANCE_KEYWORDS = {
  en: {
    boost: [
      // Political/government
      'election', 'government', 'parliament', 'president', 'prime minister',
      'cabinet', 'court', 'supreme court', 'verdict', 'law', 'policy',
      // War/conflict
      'war', 'conflict', 'attack', 'military', 'strike', 'troops', 'ceasefire',
      'killed', 'casualties', 'terror',
      // Natural disasters
      'earthquake', 'flood', 'cyclone', 'disaster', 'wildfire', 'landslide',
      'tsunami', 'evacuate',
      // Economic/financial - see docs/ranking-tuning.md for why this is
      // deliberately narrower than generic financial vocabulary.
      'rbi', 'inflation', 'recession', 'market crash', 'gdp',
      'interest rate', 'budget',
      // Major corporate
      'acquisition', 'merger', 'ipo', 'bankruptcy', 'layoffs', 'ceo resigns',
      // Major tech
      'breakthrough', 'launch', 'unveils', 'ai model', 'chip',
      // Major sports
      'world cup', 'olympics', 'final', 'championship', 'gold medal',
      // Deaths of public figures
      'dies', 'death', 'passes away', 'obituary',
    ],
    penalize: [
      'opinion', 'editorial', 'column', 'horoscope', 'astrology', 'recipe',
      'celebrity', 'gossip', 'style', 'fashion trend', 'listicle',
      'top 10', 'top 5', 'things you', 'you won’t believe', 'life hacks',
      'announces partnership', 'announces collaboration',
      // Inspirational/filler content - see docs/ranking-tuning.md.
      'proverb', 'quote of the day', 'thought for the day', 'motivational',
      'motivational quote', 'life lesson', 'moral of the story', 'zen story',
      'inspirational story', 'did you know',
    ],
  },
  hi: {
    boost: [
      'चुनाव', 'सरकार', 'संसद', 'राष्ट्रपति', 'प्रधानमंत्री',
      'मंत्रिमंडल', 'अदालत', 'सुप्रीम कोर्ट', 'फैसला', 'कानून', 'नीति',
      'युद्ध', 'संघर्ष', 'हमला', 'सेना', 'हड़ताल', 'सैनिक', 'युद्धविराम',
      'मारे गए', 'हताहत', 'आतंक',
      'भूकंप', 'बाढ़', 'चक्रवात', 'आपदा', 'जंगल की आग', 'भूस्खलन',
      'सुनामी', 'निकासी',
      'rbi', 'महंगाई', 'मंदी', 'बाजार दुर्घटना', 'gdp',
      'ब्याज दर', 'बजट',
      'अधिग्रहण', 'विलय', 'ipo', 'दिवालिया', 'छंटनी', 'सीईओ इस्तीफा',
      'सफलता', 'लॉन्च', 'पेश किया', 'एआई मॉडल', 'चिप',
      'विश्व कप', 'ओलंपिक', 'फाइनल', 'चैंपियनशिप', 'स्वर्ण पदक',
      'निधन', 'मृत्यु', 'मृत्यु हो गई', 'श्रद्धांजलि',
    ],
    penalize: [
      'राय', 'संपादकीय', 'स्तंभ', 'राशिफल', 'ज्योतिष', 'रेसिपी',
      'सेलिब्रिटी', 'गॉसिप', 'स्टाइल', 'फैशन ट्रेंड', 'लिस्टिकल',
      'टॉप 10', 'टॉप 5', 'आपको नहीं पता होगा', 'लाइफ हैक्स',
      'साझेदारी की घोषणा', 'सहयोग की घोषणा',
      'कहावत', 'आज का सुविचार', 'आज का विचार', 'प्रेरक',
      'प्रेरक विचार', 'जीवन का सबक', 'कहानी की सीख', 'ज़ेन कहानी',
      'प्रेरणादायक कहानी', 'क्या आप जानते हैं',
    ],
  },
  gu: {
    boost: [
      'ચૂંટણી', 'સરકાર', 'સંસદ', 'રાષ્ટ્રપતિ', 'વડાપ્રધાન',
      'મંત્રીમંડળ', 'અદાલત', 'સુપ્રીમ કોર્ટ', 'ચુકાદો', 'કાયદો', 'નીતિ',
      'યુદ્ધ', 'સંઘર્ષ', 'હુમલો', 'સૈન્ય', 'હડતાલ', 'સૈનિકો', 'યુદ્ધવિરામ',
      'માર્યા ગયા', 'જાનહાનિ', 'આતંક',
      'ભૂકંપ', 'પૂર', 'ચક્રવાત', 'આપત્તિ', 'જંગલમાં આગ', 'ભૂસ્ખલન',
      'સુનામી', 'સ્થળાંતર',
      'rbi', 'ફુગાવો', 'મંદી', 'બજાર કડાકો', 'gdp',
      'વ્યાજ દર', 'બજેટ',
      'એક્વિઝિશન', 'મર્જર', 'ipo', 'નાદારી', 'છટણી', 'સીઈઓ રાજીનામું',
      'સફળતા', 'લોન્ચ', 'રજૂ કર્યું', 'એઆઈ મોડલ', 'ચિપ',
      'વર્લ્ડ કપ', 'ઓલિમ્પિક', 'ફાઇનલ', 'ચેમ્પિયનશિપ', 'ગોલ્ડ મેડલ',
      'અવસાન', 'મૃત્યુ', 'મૃત્યુ પામ્યા', 'શ્રદ્ધાંજલિ',
    ],
    penalize: [
      'અભિપ્રાય', 'તંત્રીલેખ', 'કોલમ', 'રાશિફળ', 'જ્યોતિષ', 'રેસિપી',
      'સેલિબ્રિટી', 'ગોસિપ', 'સ્ટાઇલ', 'ફેશન ટ્રેન્ડ', 'લિસ્ટિકલ',
      'ટોપ 10', 'ટોપ 5', 'તમને ખબર નહીં હોય', 'લાઈફ હેક્સ',
      'ભાગીદારીની જાહેરાત', 'સહયોગની જાહેરાત',
      'કહેવત', 'આજનું સુવિચાર', 'આજનો વિચાર', 'પ્રેરક',
      'પ્રેરક વિચાર', 'જીવન પાઠ', 'વાર્તાનો બોધ', 'ઝેન વાર્તા',
      'પ્રેરણાદાયી વાર્તા', 'શું તમે જાણો છો',
    ],
  },
  bn: {
    boost: [
      'নির্বাচন', 'সরকার', 'সংসদ', 'রাষ্ট্রপতি', 'প্রধানমন্ত্রী',
      'মন্ত্রিসভা', 'আদালত', 'সুপ্রিম কোর্ট', 'রায়', 'আইন', 'নীতি',
      'যুদ্ধ', 'সংঘর্ষ', 'হামলা', 'সেনাবাহিনী', 'ধর্মঘট', 'সেনা', 'যুদ্ধবিরতি',
      'নিহত', 'হতাহত', 'সন্ত্রাস',
      'ভূমিকম্প', 'বন্যা', 'ঘূর্ণিঝড়', 'দুর্যোগ', 'দাবানল', 'ভূমিধস',
      'সুনামি', 'সরিয়ে নেওয়া',
      'rbi', 'মুদ্রাস্ফীতি', 'মন্দা', 'বাজার ধস', 'gdp',
      'সুদের হার', 'বাজেট',
      'অধিগ্রহণ', 'একীভবন', 'ipo', 'দেউলিয়া', 'ছাঁটাই', 'সিইও পদত্যাগ',
      'যুগান্তকারী', 'লঞ্চ', 'উন্মোচন', 'এআই মডেল', 'চিপ',
      'বিশ্বকাপ', 'অলিম্পিক', 'ফাইনাল', 'চ্যাম্পিয়নশিপ', 'স্বর্ণপদক',
      'মৃত্যু', 'প্রয়াত হয়েছেন', 'শোকগাথা',
    ],
    penalize: [
      'মতামত', 'সম্পাদকীয়', 'কলাম', 'রাশিফল', 'জ্যোতিষ', 'রেসিপি',
      'সেলিব্রিটি', 'গসিপ', 'স্টাইল', 'ফ্যাশন ট্রেন্ড', 'লিস্টিকল',
      'টপ ১০', 'টপ ৫', 'যা আপনি জানতেন না', 'লাইফ হ্যাকস',
      'অংশীদারিত্বের ঘোষণা', 'সহযোগিতার ঘোষণা',
      'প্রবাদ', 'আজকের উক্তি', 'আজকের ভাবনা', 'অনুপ্রেরণামূলক',
      'অনুপ্রেরণামূলক উক্তি', 'জীবনের শিক্ষা', 'গল্পের নীতিশিক্ষা', 'জেন গল্প',
      'অনুপ্রেরণামূলক গল্প', 'আপনি কি জানেন',
    ],
  },
  kn: {
    boost: [
      'ಚುನಾವಣೆ', 'ಸರ್ಕಾರ', 'ಸಂಸತ್ತು', 'ರಾಷ್ಟ್ರಪತಿ', 'ಪ್ರಧಾನಿ',
      'ಸಚಿವ ಸಂಪುಟ', 'ನ್ಯಾಯಾಲಯ', 'ಸುಪ್ರೀಂ ಕೋರ್ಟ್', 'ತೀರ್ಪು', 'ಕಾನೂನು', 'ನೀತಿ',
      'ಯುದ್ಧ', 'ಸಂಘರ್ಷ', 'ದಾಳಿ', 'ಸೇನೆ', 'ಮುಷ್ಕರ', 'ಸೈನಿಕರು', 'ಕದನ ವಿರಾಮ',
      'ಹತ್ಯೆ', 'ಸಾವುನೋವು', 'ಭಯೋತ್ಪಾದನೆ',
      'ಭೂಕಂಪ', 'ಪ್ರವಾಹ', 'ಚಂಡಮಾರುತ', 'ವಿಪತ್ತು', 'ಕಾಡ್ಗಿಚ್ಚು', 'ಭೂಕುಸಿತ',
      'ಸುನಾಮಿ', 'ಸ್ಥಳಾಂತರ',
      'rbi', 'ಹಣದುಬ್ಬರ', 'ಆರ್ಥಿಕ ಹಿಂಜರಿತ', 'ಮಾರುಕಟ್ಟೆ ಕುಸಿತ', 'gdp',
      'ಬಡ್ಡಿ ದರ', 'ಬಜೆಟ್',
      'ಸ್ವಾಧೀನ', 'ವಿಲೀನ', 'ipo', 'ದಿವಾಳಿತನ', 'ಉದ್ಯೋಗ ಕಡಿತ', 'ಸಿಇಒ ರಾಜೀನಾಮೆ',
      'ಪ್ರಗತಿ', 'ಬಿಡುಗಡೆ', 'ಅನಾವರಣ', 'ಎಐ ಮಾದರಿ', 'ಚಿಪ್',
      'ವಿಶ್ವಕಪ್', 'ಒಲಿಂಪಿಕ್ಸ್', 'ಫೈನಲ್', 'ಚಾಂಪಿಯನ್‌ಶಿಪ್', 'ಚಿನ್ನದ ಪದಕ',
      'ನಿಧನ', 'ಅಗಲಿದರು', 'ಸಂತಾಪ',
    ],
    penalize: [
      'ಅಭಿಪ್ರಾಯ', 'ಸಂಪಾದಕೀಯ', 'ಅಂಕಣ', 'ಭವಿಷ್ಯ', 'ಜ್ಯೋತಿಷ್ಯ', 'ಪಾಕವಿಧಾನ',
      'ಸೆಲೆಬ್ರಿಟಿ', 'ಗಾಸಿಪ್', 'ಸ್ಟೈಲ್', 'ಫ್ಯಾಷನ್ ಟ್ರೆಂಡ್', 'ಲಿಸ್ಟಿಕಲ್',
      'ಟಾಪ್ 10', 'ಟಾಪ್ 5', 'ನಿಮಗೆ ಗೊತ್ತಿಲ್ಲದ ಸಂಗತಿಗಳು', 'ಲೈಫ್ ಹ್ಯಾಕ್ಸ್',
      'ಪಾಲುದಾರಿಕೆ ಘೋಷಣೆ', 'ಸಹಯೋಗ ಘೋಷಣೆ',
      'ಗಾದೆ', 'ಇಂದಿನ ಉಲ್ಲೇಖ', 'ಇಂದಿನ ಆಲೋಚನೆ', 'ಪ್ರೇರಣಾದಾಯಕ',
      'ಪ್ರೇರಣಾದಾಯಕ ಉಲ್ಲೇಖ', 'ಜೀವನ ಪಾಠ', 'ಕಥೆಯ ನೀತಿ', 'ಝೆನ್ ಕಥೆ',
      'ಸ್ಪೂರ್ತಿದಾಯಕ ಕಥೆ', 'ನಿಮಗೆ ಗೊತ್ತೇ',
    ],
  },
  mr: {
    boost: [
      'निवडणूक', 'सरकार', 'संसद', 'राष्ट्रपती', 'पंतप्रधान',
      'मंत्रिमंडळ', 'न्यायालय', 'सर्वोच्च न्यायालय', 'निकाल', 'कायदा', 'धोरण',
      'युद्ध', 'संघर्ष', 'हल्ला', 'लष्कर', 'संप', 'सैनिक', 'युद्धविराम',
      'ठार', 'जीवितहानी', 'दहशतवाद',
      'भूकंप', 'पूर', 'चक्रीवादळ', 'आपत्ती', 'वणवा', 'भूस्खलन',
      'त्सुनामी', 'स्थलांतर',
      'rbi', 'महागाई', 'मंदी', 'बाजार कोसळला', 'gdp',
      'व्याजदर', 'अर्थसंकल्प',
      'अधिग्रहण', 'विलीनीकरण', 'ipo', 'दिवाळखोरी', 'नोकरकपात', 'सीईओ राजीनामा',
      'यश', 'लाँच', 'सादर केले', 'एआय मॉडेल', 'चिप',
      'वर्ल्ड कप', 'ऑलिम्पिक', 'अंतिम सामना', 'अजिंक्यपद', 'सुवर्णपदक',
      'निधन', 'मृत्यू झाला', 'श्रद्धांजली',
    ],
    penalize: [
      'मत', 'संपादकीय', 'स्तंभ', 'राशीभविष्य', 'ज्योतिष', 'पाककृती',
      'सेलिब्रिटी', 'गॉसिप', 'स्टाईल', 'फॅशन ट्रेंड', 'लिस्टिकल',
      'टॉप १०', 'टॉप ५', 'तुम्हाला माहीत नसलेल्या गोष्टी', 'लाइफ हॅक्स',
      'भागीदारीची घोषणा', 'सहकार्याची घोषणा',
      'म्हण', 'आजचा सुविचार', 'आजचा विचार', 'प्रेरणादायी',
      'प्रेरणादायी विचार', 'जीवनाचा धडा', 'गोष्टीचे तात्पर्य', 'झेन कथा',
      'प्रेरणादायी कथा', 'तुम्हाला माहीत आहे का',
    ],
  },
  ml: {
    boost: [
      'തിരഞ്ഞെടുപ്പ്', 'സർക്കാർ', 'പാർലമെന്റ്', 'രാഷ്ട്രപതി', 'പ്രധാനമന്ത്രി',
      'മന്ത്രിസഭ', 'കോടതി', 'സുപ്രീം കോടതി', 'വിധി', 'നിയമം', 'നയം',
      'യുദ്ധം', 'സംഘർഷം', 'ആക്രമണം', 'സൈന്യം', 'സമരം', 'സൈനികർ', 'വെടിനിർത്തൽ',
      'കൊല്ലപ്പെട്ടു', 'മരണസംഖ്യ', 'ഭീകരത',
      'ഭൂകമ്പം', 'വെള്ളപ്പൊക്കം', 'ചുഴലിക്കാറ്റ്', 'ദുരന്തം', 'കാട്ടുതീ', 'മണ്ണിടിച്ചിൽ',
      'സുനാമി', 'ഒഴിപ്പിക്കൽ',
      'rbi', 'പണപ്പെരുപ്പം', 'സാമ്പത്തിക മാന്ദ്യം', 'വിപണി തകർച്ച', 'gdp',
      'പലിശ നിരക്ക്', 'ബജറ്റ്',
      'ഏറ്റെടുക്കൽ', 'ലയനം', 'ipo', 'പാപ്പരത്തം', 'പിരിച്ചുവിടൽ', 'സിഇഒ രാജി',
      'മുന്നേറ്റം', 'ലോഞ്ച്', 'അനാച്ഛാദനം ചെയ്തു', 'എഐ മോഡൽ', 'ചിപ്പ്',
      'ലോകകപ്പ്', 'ഒളിമ്പിക്സ്', 'ഫൈനൽ', 'ചാമ്പ്യൻഷിപ്പ്', 'സ്വർണ്ണ മെഡൽ',
      'അന്തരിച്ചു', 'മരണമടഞ്ഞു', 'അനുശോചനം',
    ],
    penalize: [
      'അഭിപ്രായം', 'മുഖപ്രസംഗം', 'കോളം', 'ജാതകം', 'ജ്യോതിഷം', 'പാചകക്കുറിപ്പ്',
      'സെലിബ്രിറ്റി', 'ഗോസിപ്പ്', 'സ്റ്റൈൽ', 'ഫാഷൻ ട്രെൻഡ്', 'ലിസ്റ്റിക്കിൾ',
      'ടോപ്പ് 10', 'ടോപ്പ് 5', 'നിങ്ങൾക്കറിയാത്ത കാര്യങ്ങൾ', 'ലൈഫ് ഹാക്കുകൾ',
      'പങ്കാളിത്തം പ്രഖ്യാപിച്ചു', 'സഹകരണം പ്രഖ്യാപിച്ചു',
      'പഴഞ്ചൊല്ല്', 'ഇന്നത്തെ ഉദ്ധരണി', 'ഇന്നത്തെ ചിന്ത', 'പ്രചോദനാത്മകം',
      'പ്രചോദനാത്മക ഉദ്ധരണി', 'ജീവിത പാഠം', 'കഥയുടെ ഗുണപാഠം', 'സെൻ കഥ',
      'പ്രചോദനാത്മക കഥ', 'നിങ്ങൾക്കറിയാമോ',
    ],
  },
  ta: {
    boost: [
      'தேர்தல்', 'அரசு', 'பாராளுமன்றம்', 'குடியரசுத் தலைவர்', 'பிரதமர்',
      'அமைச்சரவை', 'நீதிமன்றம்', 'உச்ச நீதிமன்றம்', 'தீர்ப்பு', 'சட்டம்', 'கொள்கை',
      'போர்', 'மோதல்', 'தாக்குதல்', 'இராணுவம்', 'வேலைநிறுத்தம்', 'படைவீரர்கள்',
      'போர்நிறுத்தம்', 'கொல்லப்பட்டனர்', 'உயிரிழப்பு', 'பயங்கரவாதம்',
      'நிலநடுக்கம்', 'வெள்ளம்', 'புயல்', 'பேரிடர்', 'காட்டுத் தீ', 'நிலச்சரிவு',
      'சுனாமி', 'வெளியேற்றம்',
      'rbi', 'பணவீக்கம்', 'பொருளாதார மந்தநிலை', 'சந்தை சரிவு', 'gdp',
      'வட்டி விகிதம்', 'பட்ஜெட்',
      'கையகப்படுத்தல்', 'இணைப்பு', 'ipo', 'திவால்', 'பணிநீக்கம்', 'தலைமை நிர்வாகி ராஜினாமா',
      'முன்னேற்றம்', 'வெளியீடு', 'அறிமுகப்படுத்தியது', 'ஏஐ மாடல்', 'சிப்',
      'உலகக் கோப்பை', 'ஒலிம்பிக்ஸ்', 'இறுதிப் போட்டி', 'சாம்பியன்ஷிப்', 'தங்கப் பதக்கம்',
      'காலமானார்', 'இறந்தார்', 'இரங்கல்',
    ],
    penalize: [
      'கருத்து', 'தலையங்கம்', 'பத்தி', 'ராசிபலன்', 'ஜோதிடம்', 'சமையல் குறிப்பு',
      'செலிபிரிட்டி', 'வதந்தி', 'ஸ்டைல்', 'ஃபேஷன் டிரெண்ட்', 'லிஸ்டிக்கல்',
      'டாப் 10', 'டாப் 5', 'உங்களுக்குத் தெரியாதவை', 'லைஃப் ஹேக்ஸ்',
      'கூட்டாண்மை அறிவிப்பு', 'ஒத்துழைப்பு அறிவிப்பு',
      'பழமொழி', 'இன்றைய மேற்கோள்', 'இன்றைய எண்ணம்', 'ஊக்கமளிக்கும்',
      'ஊக்கமளிக்கும் மேற்கோள்', 'வாழ்க்கை பாடம்', 'கதையின் நீதி', 'ஜென் கதை',
      'ஊக்கமளிக்கும் கதை', 'உங்களுக்குத் தெரியுமா',
    ],
  },
  te: {
    boost: [
      'ఎన్నికలు', 'ప్రభుత్వం', 'పార్లమెంట్', 'రాష్ట్రపతి', 'ప్రధానమంత్రి',
      'మంత్రివర్గం', 'న్యాయస్థానం', 'సుప్రీంకోర్టు', 'తీర్పు', 'చట్టం', 'విధానం',
      'యుద్ధం', 'సంఘర్షణ', 'దాడి', 'సైన్యం', 'సమ్మె', 'సైనికులు', 'కాల్పుల విరమణ',
      'మృతి', 'మరణాలు', 'ఉగ్రవాదం',
      'భూకంపం', 'వరద', 'తుఫాను', 'విపత్తు', 'అడవి మంటలు', 'కొండచరియలు విరిగిపడటం',
      'సునామీ', 'తరలింపు',
      'rbi', 'ద్రవ్యోల్బణం', 'మాంద్యం', 'మార్కెట్ పతనం', 'gdp',
      'వడ్డీ రేటు', 'బడ్జెట్',
      'సేకరణ', 'విలీనం', 'ipo', 'దివాలా', 'తొలగింపులు', 'సీఈఓ రాజీనామా',
      'పురోగతి', 'లాంచ్', 'ఆవిష్కరించింది', 'ఏఐ మోడల్', 'చిప్',
      'ప్రపంచ కప్', 'ఒలింపిక్స్', 'ఫైనల్', 'ఛాంపియన్‌షిప్', 'స్వర్ణ పతకం',
      'మరణించారు', 'కన్నుమూశారు', 'సంతాప సందేశం',
    ],
    penalize: [
      'అభిప్రాయం', 'సంపాదకీయం', 'కాలమ్', 'రాశిఫలాలు', 'జ్యోతిష్యం', 'వంటకం',
      'సెలబ్రిటీ', 'గాసిప్', 'స్టైల్', 'ఫ్యాషన్ ట్రెండ్', 'లిస్టికల్',
      'టాప్ 10', 'టాప్ 5', 'మీకు తెలియని విషయాలు', 'లైఫ్ హ్యాక్స్',
      'భాగస్వామ్య ప్రకటన', 'సహకార ప్రకటన',
      'సామెత', 'నేటి కోట్', 'నేటి ఆలోచన', 'ప్రేరణాత్మక',
      'ప్రేరణాత్మక కోట్', 'జీవిత పాఠం', 'కథ నీతి', 'జెన్ కథ',
      'స్ఫూర్తిదాయక కథ', 'మీకు తెలుసా',
    ],
  },
  or: {
    boost: [
      'ନିର୍ବାଚନ', 'ସରକାର', 'ସଂସଦ', 'ରାଷ୍ଟ୍ରପତି', 'ପ୍ରଧାନମନ୍ତ୍ରୀ',
      'ମନ୍ତ୍ରିମଣ୍ଡଳ', 'ନ୍ୟାୟାଳୟ', 'ସୁପ୍ରିମକୋର୍ଟ', 'ରାୟ', 'ଆଇନ', 'ନୀତି',
      'ଯୁଦ୍ଧ', 'ସଂଘର୍ଷ', 'ଆକ୍ରମଣ', 'ସେନା', 'ଧର୍ମଘଟ', 'ସୈନିକ', 'ଯୁଦ୍ଧବିରତି',
      'ନିହତ', 'ହତାହତ', 'ସନ୍ତ୍ରାସ',
      'ଭୂକମ୍ପ', 'ବନ୍ୟା', 'ଘୂର୍ଣ୍ଣିବାତ୍ୟା', 'ବିପର୍ଯ୍ୟୟ', 'ଜଙ୍ଗଲ ନିଆଁ', 'ଭୂସ୍ଖଳନ',
      'ସୁନାମି', 'ସ୍ଥାନାନ୍ତର',
      'rbi', 'ମୁଦ୍ରାସ୍ଫୀତି', 'ମାନ୍ଦା', 'ବଜାର ଧସ', 'gdp',
      'ସୁଧ ହାର', 'ବଜେଟ',
      'ଅଧିଗ୍ରହଣ', 'ମିଶ୍ରଣ', 'ipo', 'ଦେଉଳିଆପଣ', 'ଛଟେଇ', 'ସିଇଓ ଇସ୍ତଫା',
      'ଅଗ୍ରଗତି', 'ଲଞ୍ଚ', 'ଉନ୍ମୋଚନ', 'ଏଆଇ ମଡେଲ', 'ଚିପ',
      'ବିଶ୍ୱକପ', 'ଅଲିମ୍ପିକ୍ସ', 'ଫାଇନାଲ', 'ଚାମ୍ପିଅନସିପ', 'ସ୍ୱର୍ଣ୍ଣ ପଦକ',
      'ପରଲୋକଗମନ', 'ମୃତ୍ୟୁ ହେଲା', 'ଶ୍ରଦ୍ଧାଞ୍ଜଳି',
    ],
    penalize: [
      'ମତାମତ', 'ସମ୍ପାଦକୀୟ', 'ସ୍ତମ୍ଭ', 'ରାଶିଫଳ', 'ଜ୍ୟୋତିଷ', 'ରାନ୍ଧଣା ବିଧି',
      'ସେଲିବ୍ରିଟି', 'ଗସିପ', 'ଷ୍ଟାଇଲ', 'ଫ୍ୟାସନ ଟ୍ରେଣ୍ଡ', 'ଲିଷ୍ଟିକଲ',
      'ଟପ 10', 'ଟପ 5', 'ଆପଣ ଜାଣି ନଥିବା ବିଷୟ', 'ଲାଇଫ ହ୍ୟାକ୍ସ',
      'ଭାଗିଦାରୀ ଘୋଷଣା', 'ସହଯୋଗ ଘୋଷଣା',
      'ପ୍ରବାଦ', 'ଆଜିର ଉକ୍ତି', 'ଆଜିର ଚିନ୍ତା', 'ଅନୁପ୍ରେରଣାଦାୟକ',
      'ଅନୁପ୍ରେରଣାଦାୟକ ଉକ୍ତି', 'ଜୀବନ ପାଠ', 'କାହାଣୀର ନୀତି', 'ଜେନ କାହାଣୀ',
      'ଅନୁପ୍ରେରଣାଦାୟକ କାହାଣୀ', 'ଆପଣ ଜାଣନ୍ତି କି',
    ],
  },
};

// See "Single-company stock-price penalty pattern" in docs/ranking-tuning.md.
// Language-agnostic (numeric/percentage pattern, not a keyword list) so this
// applies the same way regardless of article.language.
const IMPORTANCE_PENALIZE_PATTERNS = [
  /\bshares?\b[^.]{0,60}\b\d+(\.\d+)?\s*%/i,
  /\bstocks?\b[^.]{0,60}\b\d+(\.\d+)?\s*%/i,
];

// How much each keyword match shifts the score, and the floor/ceiling it's
// clamped to afterwards - the pattern-based penalty is weighted heavier
// than a single keyword match (see docs/ranking-tuning.md).
const IMPORTANCE_BOOST_WEIGHT = 0.08;
const IMPORTANCE_PENALIZE_WEIGHT = 0.1;
const IMPORTANCE_PATTERN_PENALIZE_WEIGHT = 0.15;
const IMPORTANCE_MIN = 0;
const IMPORTANCE_MAX = 1;

// See "Diversity caps" in docs/ranking-tuning.md.
const MAX_PER_SOURCE = 3;
const MAX_PER_CATEGORY = 4;

// How many recent rows to pull from the DB before ranking - large enough to
// give the ranker a meaningful pool without ranking the entire table.
const CANDIDATE_POOL_SIZE = 100;
const DEFAULT_TOP_STORIES_LIMIT = 20;

module.exports = {
  FRESHNESS_DECAY_HOURS,
  RANKING_WEIGHTS,
  SOURCE_AUTHORITY,
  DEFAULT_SOURCE_AUTHORITY,
  IMPORTANCE_BASELINE,
  IMPORTANCE_KEYWORDS,
  IMPORTANCE_PENALIZE_PATTERNS,
  IMPORTANCE_BOOST_WEIGHT,
  IMPORTANCE_PENALIZE_WEIGHT,
  IMPORTANCE_PATTERN_PENALIZE_WEIGHT,
  IMPORTANCE_MIN,
  IMPORTANCE_MAX,
  MAX_PER_SOURCE,
  MAX_PER_CATEGORY,
  CANDIDATE_POOL_SIZE,
  DEFAULT_TOP_STORIES_LIMIT,
};
