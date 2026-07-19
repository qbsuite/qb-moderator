// answer_checker.js — vendored qbreader answer checker (classic script).
//
// This is qb-answer-checker v1.1.9 (github.com/qbreader/qb-answer-checker,
// commit c6a7f49, ISC © Geoffrey Wu) with its four runtime dependencies
// inlined so the reader can load it as a plain <script> over file:// —
// no bundler, no ESM. Source is kept verbatim (imports/exports stripped,
// everything wrapped in one IIFE) so future upstream syncs are a diff away:
//   damerau-levenshtein-js 1.1.8 (MIT © Fabvalaaah)
//   stemmer 2.0.1             (MIT © Titus Wormer)
//   number-to-words 1.2.4     (MIT © Martin Eneqvist)
//   roman-numerals 0.3.2      (Apache-2.0 © Erik Koopmans)
//
// Exposes window.qbCheckAnswer(answerline, givenAnswer, strictness?) ->
// { directive: 'accept'|'prompt'|'reject', directedPrompt?: string }.
// The answerline should be the raw formatted (<b>/<u> markup) string when
// available — underlining drives the required-words logic.
(function () {
  'use strict';

  /* ================= damerau-levenshtein-js 1.1.8 ================= */
  const initMatrix = (s1, s2) => {
    if (undefined == s1 || undefined == s2) {
      return null;
    }

    let d = [];
    for (let i = 0; i <= s1.length; i++) {
      d[i] = [];
      d[i][0] = i;
    }
    for (let j = 0; j <= s2.length; j++) {
      d[0][j] = j;
    }

    return d;
  };

  const damerau = (i, j, s1, s2, d, cost) => {
    if (i > 1 && j > 1 && s1[i - 1] === s2[j - 2] && s1[i - 2] === s2[j - 1]) {
      d[i][j] = Math.min.apply(null, [d[i][j], d[i - 2][j - 2] + cost]);
    }
  };

  const distance = (s1, s2) => {
    if (
      undefined == s1 ||
      undefined == s2 ||
      'string' !== typeof s1 ||
      'string' !== typeof s2
    ) {
      return -1;
    }

    let d = initMatrix(s1, s2);
    if (null === d) {
      return -1;
    }
    for (var i = 1; i <= s1.length; i++) {
      let cost;
      for (let j = 1; j <= s2.length; j++) {
        if (s1.charAt(i - 1) === s2.charAt(j - 1)) {
          cost = 0;
        } else {
          cost = 1;
        }

        d[i][j] = Math.min.apply(null, [
          d[i - 1][j] + 1,
          d[i][j - 1] + 1,
          d[i - 1][j - 1] + cost,
        ]);

        damerau(i, j, s1, s2, d, cost);
      }
    }

    return d[s1.length][s2.length];
  };

  /* ======================= stemmer 2.0.1 ======================= */
  const step2list = {
    ational: 'ate',
    tional: 'tion',
    enci: 'ence',
    anci: 'ance',
    izer: 'ize',
    bli: 'ble',
    alli: 'al',
    entli: 'ent',
    eli: 'e',
    ousli: 'ous',
    ization: 'ize',
    ation: 'ate',
    ator: 'ate',
    alism: 'al',
    iveness: 'ive',
    fulness: 'ful',
    ousness: 'ous',
    aliti: 'al',
    iviti: 'ive',
    biliti: 'ble',
    logi: 'log'
  };

  const step3list = {
    icate: 'ic',
    ative: '',
    alize: 'al',
    iciti: 'ic',
    ical: 'ic',
    ful: '',
    ness: ''
  };

  const consonant = '[^aeiou]';
  const vowel = '[aeiouy]';
  const consonants = '(' + consonant + '[^aeiouy]*)';
  const vowels = '(' + vowel + '[aeiou]*)';

  const gt0 = new RegExp('^' + consonants + '?' + vowels + consonants);
  const eq1 = new RegExp(
    '^' + consonants + '?' + vowels + consonants + vowels + '?$'
  );
  const gt1 = new RegExp('^' + consonants + '?(' + vowels + consonants + '){2,}');
  const vowelInStem = new RegExp('^' + consonants + '?' + vowel);
  const consonantLike = new RegExp('^' + consonants + vowel + '[^aeiouwxy]$');

  const sfxLl = /ll$/;
  const sfxE = /^(.+?)e$/;
  const sfxY = /^(.+?)y$/;
  const sfxIon = /^(.+?(s|t))(ion)$/;
  const sfxEdOrIng = /^(.+?)(ed|ing)$/;
  const sfxAtOrBlOrIz = /(at|bl|iz)$/;
  const sfxEED = /^(.+?)eed$/;
  const sfxS = /^.+?[^s]s$/;
  const sfxSsesOrIes = /^.+?(ss|i)es$/;
  const sfxMultiConsonantLike = /([^aeiouylsz])\1$/;
  const step2 =
    /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
  const step3 = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
  const step4 =
    /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;

  function stemmer(value) {
    let result = String(value).toLowerCase();

    if (result.length < 3) {
      return result;
    }

    let firstCharacterWasLowerCaseY = false;

    if (
      result.codePointAt(0) === 121 // Lowercase Y
    ) {
      firstCharacterWasLowerCaseY = true;
      result = 'Y' + result.slice(1);
    }

    // Step 1a.
    if (sfxSsesOrIes.test(result)) {
      result = result.slice(0, -2);
    } else if (sfxS.test(result)) {
      result = result.slice(0, -1);
    }

    let match;

    // Step 1b.
    if ((match = sfxEED.exec(result))) {
      if (gt0.test(match[1])) {
        result = result.slice(0, -1);
      }
    } else if ((match = sfxEdOrIng.exec(result)) && vowelInStem.test(match[1])) {
      result = match[1];

      if (sfxAtOrBlOrIz.test(result)) {
        result += 'e';
      } else if (sfxMultiConsonantLike.test(result)) {
        result = result.slice(0, -1);
      } else if (consonantLike.test(result)) {
        result += 'e';
      }
    }

    // Step 1c.
    if ((match = sfxY.exec(result)) && vowelInStem.test(match[1])) {
      result = match[1] + 'i';
    }

    // Step 2.
    if ((match = step2.exec(result)) && gt0.test(match[1])) {
      result = match[1] + step2list[match[2]];
    }

    // Step 3.
    if ((match = step3.exec(result)) && gt0.test(match[1])) {
      result = match[1] + step3list[match[2]];
    }

    // Step 4.
    if ((match = step4.exec(result))) {
      if (gt1.test(match[1])) {
        result = match[1];
      }
    } else if ((match = sfxIon.exec(result)) && gt1.test(match[1])) {
      result = match[1];
    }

    // Step 5.
    if (
      (match = sfxE.exec(result)) &&
      (gt1.test(match[1]) ||
        (eq1.test(match[1]) && !consonantLike.test(match[1])))
    ) {
      result = match[1];
    }

    if (sfxLl.test(result) && gt1.test(result)) {
      result = result.slice(0, -1);
    }

    if (firstCharacterWasLowerCaseY) {
      result = 'y' + result.slice(1);
    }

    return result;
  }

  /* ==================== number-to-words 1.2.4 ==================== */
  const TEN = 10;
  const ONE_HUNDRED = 100;
  const ONE_THOUSAND = 1000;
  const ONE_MILLION = 1000000;
  const ONE_BILLION = 1000000000;
  const ONE_TRILLION = 1000000000000;
  const ONE_QUADRILLION = 1000000000000000;
  const MAX = 9007199254740992;
  const MAX_SAFE_INTEGER = 9007199254740991;

  const LESS_THAN_TWENTY = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'
  ];

  const TENTHS_LESS_THAN_HUNDRED = [
    'zero', 'ten', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'
  ];

  function ntwIsFinite(value) {
    return !(typeof value !== 'number' || value !== value || value === Infinity || value === -Infinity);
  }

  function isSafeNumber(value) {
    return typeof value === 'number' && Math.abs(value) <= MAX_SAFE_INTEGER;
  }

  function toWords(number) {
    var words;
    var num = parseInt(number, 10);

    if (!ntwIsFinite(num)) {
      throw new TypeError(
        'Not a finite number: ' + number + ' (' + typeof number + ')'
      );
    }
    if (!isSafeNumber(num)) {
      throw new RangeError(
        'Input is not a safe number, it’s either too large or too small.'
      );
    }
    words = generateWords(num);
    return words;
  }

  function generateWords(number) {
    var remainder, word,
      words = arguments[1];

    if (number === 0) {
      return !words ? 'zero' : words.join(' ').replace(/,$/, '');
    }
    if (!words) {
      words = [];
    }
    if (number < 0) {
      words.push('minus');
      number = Math.abs(number);
    }

    if (number < 20) {
      remainder = 0;
      word = LESS_THAN_TWENTY[number];

    } else if (number < ONE_HUNDRED) {
      remainder = number % TEN;
      word = TENTHS_LESS_THAN_HUNDRED[Math.floor(number / TEN)];
      if (remainder) {
        word += '-' + LESS_THAN_TWENTY[remainder];
        remainder = 0;
      }

    } else if (number < ONE_THOUSAND) {
      remainder = number % ONE_HUNDRED;
      word = generateWords(Math.floor(number / ONE_HUNDRED)) + ' hundred';

    } else if (number < ONE_MILLION) {
      remainder = number % ONE_THOUSAND;
      word = generateWords(Math.floor(number / ONE_THOUSAND)) + ' thousand,';

    } else if (number < ONE_BILLION) {
      remainder = number % ONE_MILLION;
      word = generateWords(Math.floor(number / ONE_MILLION)) + ' million,';

    } else if (number < ONE_TRILLION) {
      remainder = number % ONE_BILLION;
      word = generateWords(Math.floor(number / ONE_BILLION)) + ' billion,';

    } else if (number < ONE_QUADRILLION) {
      remainder = number % ONE_TRILLION;
      word = generateWords(Math.floor(number / ONE_TRILLION)) + ' trillion,';

    } else if (number <= MAX) {
      remainder = number % ONE_QUADRILLION;
      word = generateWords(Math.floor(number / ONE_QUADRILLION)) +
      ' quadrillion,';
    }

    words.push(word);
    return generateWords(remainder, words);
  }

  /* ===================== roman-numerals 0.3.2 ===================== */
  function toArabic(roman) {
    if (('string' !== typeof roman) && (!(roman instanceof String))) throw new TypeError('toArabic expects a string');

    if (/^nulla$/i.test(roman) || !roman.length) return 0;

    roman = roman.toUpperCase().match(/^(M{0,3})(CM|DC{0,3}|CD|C{0,3})(XC|LX{0,3}|XL|X{0,3})(IX|VI{0,3}|IV|I{0,3})$/);
    if (!roman) throw new Error('toArabic expects a valid roman number');
    var arabic = 0;

    arabic += roman[1].length * 1000;

    if (roman[2] === 'CM') arabic += 900;
    else if (roman[2] === 'CD') arabic += 400;
    else arabic += roman[2].length * 100 + (roman[2][0] === 'D' ? 400 : 0);

    if (roman[3] === 'XC') arabic += 90;
    else if (roman[3] === 'XL') arabic += 40;
    else arabic += roman[3].length * 10 + (roman[3][0] === 'L' ? 40 : 0);

    if (roman[4] === 'IX') arabic += 9;
    else if (roman[4] === 'IV') arabic += 4;
    else arabic += roman[4].length * 1 + (roman[4][0] === 'V' ? 4 : 0);
    return arabic;
  }

  /* ============== qb-answer-checker src/constants.js ============== */
  const DIRECTIVES = {
    accept: ['accept', 'or', 'antiprompt on', 'anti-prompt on', 'antiprompt', 'anti-prompt'],
    prompt: ['prompt on', 'prompt'],
    reject: ['reject', 'do not accept or prompt on', 'do not accept', 'do not prompt on', 'do not prompt']
  };
  const DIRECTIVES_FLATTENED = Object.values(DIRECTIVES).flat();

  const SPECIAL_DIRECTIVES = {
    'accept either': ['accept either', 'accept any'],
    'prompt on partial': ['prompt on partial', 'prompt on a partial', 'prompt on either']
  };

  /* ================ qb-answer-checker src/utils.js ================ */
  function extractKeyWords(string) {
    const requiredWords = extractUnderlining(string).split(' ');

    string = string
      .split(' ')
      .filter(token => token.length > 0)
      .filter(token => token.match(/<\/?u>/) || requiredWords.includes(token))
      .reduce((prev, curr) => prev + curr + ' ', '')
      .trim();

    return removeHTMLTags(string);
  }

  function extractQuotes(string) {
    const matches = string.match(/"[^"]*(?=["])/g)?.map(match => match.slice(1));

    if (matches) {
      return removeHTMLTags(matches.reduce((prev, curr) => prev + ' ' + curr, '').trim());
    } else {
      return removeHTMLTags(string);
    }
  }

  function extractUnderlining(string) {
    const matches = string.match(/<u>[^<]*(?=<\/u>)/g)?.map(match => match.slice(3));

    if (matches) {
      return removeHTMLTags(matches.reduce((prev, curr) => prev + curr + ' ', '').trim());
    } else {
      return removeHTMLTags(string);
    }
  }

  function removeHTMLTags(string) {
    return string.replace(/<[^>]*>/g, '');
  }

  function removePunctuation(string) {
    return string.replace(/[.,!;:'"\\/?@#$%^&*_~’]/g, '');
  }

  const utils = { extractKeyWords, extractQuotes, extractUnderlining, removeHTMLTags, removePunctuation };

  /* =============== qb-answer-checker src/tokenize.js =============== */
  const typoCorrections = {
    сontainor: 'container',
    сontainors: 'containers',
    сontains: 'contains',
    contentinal: 'continental',
    évaluate: 'evaluate',
    mittani: 'mitanni',
    ludmilla: 'lyudmila',
    grandma: 'grandmother',
    grandpa: 'grandfather',
    sulayman: 'solomon'
  };

  const ordinalConversions = {
    '1st': 'first',
    '2nd': 'second',
    '3rd': 'third',
    '4th': 'fourth',
    '5th': 'fifth',
    '6th': 'sixth',
    '7th': 'seventh',
    '8th': 'eighth',
    '9th': 'ninth',
    '10th': 'tenth',
    '11th': 'eleventh',
    '12th': 'twelfth',
    '13th': 'thirteenth',
    '14th': 'fourteenth',
    '15th': 'fifteenth',
    '16th': 'sixteenth',
    '17th': 'seventeenth',
    '18th': 'eighteenth',
    '19th': 'nineteenth',
    '20th': 'twentieth',
    '30th': 'thirtieth',
    '40th': 'fortieth',
    '50th': 'fiftieth',
    '60th': 'sixtieth',
    '70th': 'seventieth',
    '80th': 'eightieth',
    '90th': 'ninetieth'
  };

  const honorificConversions = {
    dr: 'doctor',
    st: 'saint',
    mr: 'mister',
    mrs: 'missus',
    ms: 'miss',
    esq: 'esquire',
    jr: 'junior',
    sr: 'senior',
    rev: 'reverend',
    fr: 'father',
    prof: 'professor',
    hon: 'honorable',
    pres: 'president',
    vp: 'vice president',
    gov: 'governor',
    ofc: 'officer',
    pr: 'pastor',
    br: 'brother',
    rep: 'representative',
    Mme: 'Madame',
    Mlle: 'Mademoiselle',
    Hr: 'Herr',
    Fr: 'Frau'
  };

  const unitConversions = {
    kg: 'kilogram',
    mol: 'mole',
    cd: 'candela',
    Hz: 'hertz',
    Pa: 'pascal',
    rad: 'radian',
    W: 'watt',
    J: 'joule',
    V: 'volt',
    Wb: 'weber',
    F: 'farad',
    Ohm: 'ohm',
    Ω: 'ohm',
    kat: 'katal',
    lm: 'lumen',
    lx: 'lux',
    Bq: 'becquerel',
    Gy: 'gray',
    Sv: 'sievert',
    in: 'inch',
    ft: 'foot',
    yd: 'yard',
    mi: 'mile',
    nmi: 'nautical mile',
    sqmi: 'square mile',
    gal: 'gallon',
    qt: 'quart',
    pt: 'pint',
    cup: 'cup'
  };

  const britishConversions = {
    colour: 'color',
    flavour: 'flavor',
    humour: 'humor',
    labour: 'labor',
    neighbour: 'neighbor',
    odour: 'odor',
    organize: 'organise',
    leukaemia: 'leukemia',
    manoeuvre: 'maneuver',
    oestrogen: 'estrogen',
    paediatric: 'pediatric'
  };

  const muhammadConversions = {
    muhammed: 'muhammad',
    muhamad: 'muhammad',
    mohammad: 'muhammad',
    mohammed: 'muhammad',
    mahammad: 'muhammad',
    maxammed: 'muhammad',
    mehemmed: 'muhammad',
    mohamad: 'muhammad',
    mohamed: 'muhammad'
  };

  function romanToWord(token) {
    try {
      token = toArabic(token);
    } catch (e) {
      if (e.message !== 'toArabic expects a valid roman number' && !(e instanceof TypeError)) {
        throw e;
      } else {
        return token;
      }
    }
    return toWords(token);
  }

  function tokenize(string, sort = false) {
    const tokens = string.split(' ').filter(token => token.length > 0);

    for (let i = 0; i <= tokens.length - 1; i++) {
      if (Object.prototype.hasOwnProperty.call(ordinalConversions, tokens[i])) {
        tokens[i] = ordinalConversions[tokens[i]];
      }

      if (Object.prototype.hasOwnProperty.call(honorificConversions, tokens[i])) {
        tokens[i] = honorificConversions[tokens[i]];
      }

      if (Object.prototype.hasOwnProperty.call(unitConversions, tokens[i])) {
        tokens[i] = unitConversions[tokens[i]];
      }

      if (Object.prototype.hasOwnProperty.call(britishConversions, tokens[i])) {
        tokens[i] = britishConversions[tokens[i]];
      }

      if (Object.prototype.hasOwnProperty.call(typoCorrections, tokens[i])) {
        tokens[i] = typoCorrections[tokens[i]];
      }

      if (Object.prototype.hasOwnProperty.call(muhammadConversions, tokens[i])) {
        tokens[i] = muhammadConversions[tokens[i]];
      }

      if (tokens[i].endsWith('s') && tokens[i].length > 1 && isFinite(tokens[i].at(-2))) {
        tokens[i] = tokens[i].slice(0, -1);
      }

      tokens[i] = romanToWord(tokens[i]);

      if (isFinite(tokens[i])) {
        tokens[i] = parseInt(tokens[i]);
        tokens[i] = tokens[i] <= 100 ? toWords(tokens[i]) : tokens[i].toString();
      }
    }

    return tokens.sort();
  }

  /* =========== qb-answer-checker src/contains-tokens.js =========== */
  function referenceContainsTokens(tokens, references, strictness, acceptSubstring, useStemmer) {
    let index = 0;
    for (const token of tokens) {
      let containsToken = false;
      while (index < references.length) {
        const reference = references[index];
        index++;
        const errors = useStemmer ? distance(stemmer(token), stemmer(reference)) : distance(token, reference);

        if (strictness > 0 && strictness * errors <= reference.length) {
          containsToken = true;
          break;
        }

        if (acceptSubstring && reference.includes(token)) {
          containsToken = true;
          break;
        }

        if (errors === 0) {
          containsToken = true;
          break;
        }
      }

      if (!containsToken) { return false; }
    }

    return true;
  }

  /* ===== qb-answer-checker src/generate-unformatted-answers.js ===== */
  const elements = {
    hydrogen: ['h'],
    helium: ['he'],
    lithium: ['li'],
    beryllium: ['be'],
    boron: ['b'],
    carbon: ['c'],
    nitrogen: ['n'],
    oxygen: ['o'],
    fluorine: ['f'],
    neon: ['ne'],
    sodium: ['na'],
    magnesium: ['mg'],
    aluminum: ['al'],
    silicon: ['si'],
    phosphorus: ['p'],
    sulfur: ['s'],
    chlorine: ['cl'],
    argon: ['ar'],
    potassium: ['k'],
    calcium: ['ca'],
    scandium: ['sc'],
    titanium: ['ti'],
    vanadium: ['v'],
    chromium: ['cr'],
    manganese: ['mn'],
    iron: ['fe'],
    cobalt: ['co'],
    nickel: ['ni'],
    copper: ['cu'],
    zinc: ['zn'],
    gallium: ['ga'],
    germanium: ['ge'],
    arsenic: ['as'],
    selenium: ['se'],
    bromine: ['br'],
    krypton: ['kr'],
    rubidium: ['rb'],
    strontium: ['sr'],
    yttrium: ['y'],
    zirconium: ['zr'],
    niobium: ['nb'],
    molybdenum: ['mo'],
    technetium: ['tc'],
    ruthenium: ['ru'],
    rhodium: ['rh'],
    palladium: ['pd'],
    silver: ['ag'],
    cadmium: ['cd'],
    indium: ['in'],
    tin: ['sn'],
    antimony: ['sb'],
    tellurium: ['te'],
    iodine: ['i'],
    xenon: ['xe'],
    cesium: ['cs'],
    barium: ['ba'],
    lanthanum: ['la'],
    cerium: ['ce'],
    praseodymium: ['pr'],
    neodymium: ['nd'],
    promethium: ['pm'],
    samarium: ['sm'],
    europium: ['eu'],
    gadolinium: ['gd'],
    terbium: ['tb'],
    dysprosium: ['dy'],
    holmium: ['ho'],
    erbium: ['er'],
    thulium: ['tm'],
    ytterbium: ['yb'],
    lutetium: ['lu'],
    hafnium: ['hf'],
    tantalum: ['ta'],
    tungsten: ['w'],
    rhenium: ['re'],
    osmium: ['os'],
    iridium: ['ir'],
    platinum: ['pt'],
    gold: ['au'],
    mercury: ['hg'],
    thallium: ['tl'],
    lead: ['pb'],
    bismuth: ['bi'],
    polonium: ['po'],
    astatine: ['at'],
    radon: ['rn'],
    francium: ['fr'],
    radium: ['ra'],
    actinium: ['ac'],
    thorium: ['th'],
    protactinium: ['pa'],
    uranium: ['u'],
    neptunium: ['np'],
    plutonium: ['pu'],
    americium: ['am'],
    curium: ['cm'],
    berkelium: ['bk'],
    californium: ['cf'],
    einsteinium: ['es'],
    fermium: ['fm'],
    mendelevium: ['md'],
    nobelium: ['no'],
    lawrencium: ['lr'],
    rutherfordium: ['rf'],
    dubnium: ['db'],
    seaborgium: ['sg'],
    bohrium: ['bh'],
    hassium: ['hs'],
    meitnerium: ['mt'],
    darmstadtium: ['ds'],
    roentgenium: ['rg'],
    copernicium: ['cn'],
    nihonium: ['nh'],
    flerovium: ['fl'],
    moscovium: ['mc'],
    livermorium: ['lv'],
    tennessine: ['ts'],
    oganesson: ['og']
  };

  const equivalentAnswers = {
    ...elements,
    'atomic bombs': ['atomic weapons', 'nuclear bombs', 'nuclear weapons', 'nukes', 'fission bombs', 'A-bombs'],
    'nuclear weapons': ['atomic bombs', 'atomic weapons', 'nuclear bombs', 'nukes', 'fission bombs', 'A-bombs'],
    nukes: ['atomic bombs', 'atomic weapons', 'nuclear bombs', 'nuclear weapons', 'fission bombs', 'A-bombs'],
    fairytales: ['fairy tales'],
    'fairy tales': ['fairytales'],
    house: ['home', 'dwelling', 'residence'],
    mouse: ['mice'],
    rail: ['railroad'],
    railroad: ['rail'],
    'nineteen eighty-four': ['1984', 'nineteen eighty four'],
    'nineteen eighty four': ['1984', 'nineteen eighty-four'],
    'oxidation number': ['oxidation state'],
    'oxidation state': ['oxidation number'],
    'ralph vaughan-williams': ['rvw'],
    spacewalk: ['space walk'],
    spacewalks: ['space walk'],
    'sugar cane': ['sugarcane'],
    sugarcane: ['sugar cane'],
    wavefunction: ['wave function'],
    'Gulf of Mexico': ['Gulf of America'],
    'wave function': ['wavefunction'],
    'world war 1': ['first world war', 'great war', 'world war i', 'world war one'],
    'world war i': ['first world war', 'great war', 'world war 1', 'world war one'],
    'world war one': ['first world war', 'great war', 'world war 1', 'world war i'],
    'world war ii': ['ww2', 'wwii', 'world war 2', 'world war two', 'second world war'],
    'world war two': ['ww2', 'wwii', 'world war ii', 'world war 2', 'second world war'],
    'world war 2': ['ww2', 'wwii', 'world war ii', 'world war two', 'second world war'],
    'Kanye West': ['kayne', 'west'],
    superconductors: ['super conductors', 'super conductor'],
    'baha\' i': ['bahai'],
    'united states of america': ['united states', 'usa', 'us', 'america'],
    'the united states of america': ['united states', 'usa', 'us', 'america'],
    usa: ['united states', 'us', 'america']
  };

  function getAbbreviation(string) {
    return string
      .split(' ')
      .filter(token => token.length > 0)
      .map(token => utils.removeHTMLTags(token).charAt(0))
      .reduce((a, b) => a + b, '')
      .trim();
  }

  function generateUnformattedAnswers(formattedAnswer, isMainAnswer) {
    if (/-/.test(formattedAnswer)) {
      const object1 = generateUnformattedAnswers(formattedAnswer.replace(/-/g, ' '), isMainAnswer);
      const object2 = generateUnformattedAnswers(formattedAnswer.replace(/-/g, ''), isMainAnswer);
      return [...object1, ...object2];
    }

    const answers = [
      utils.removeHTMLTags(formattedAnswer),
      utils.extractUnderlining(formattedAnswer),
      utils.extractKeyWords(formattedAnswer),
      utils.extractQuotes(formattedAnswer)
    ];

    if (isMainAnswer) {
      for (const answer of [formattedAnswer, utils.extractUnderlining(formattedAnswer)]) {
        const abbreviation = getAbbreviation(answer);
        if (abbreviation.length > 1) {
          answers.push(abbreviation);
        }
      }
    }

    if (answers[0] in equivalentAnswers) {
      answers.push(...equivalentAnswers[answers[0]]);
    }

    return answers.map(answer => utils.removePunctuation(answer));
  }

  /* ======== qb-answer-checker src/get-special-directives.js ======== */
  function getSpecialDirectives(answerline) {
    const directives = [];

    for (const directive of Object.keys(SPECIAL_DIRECTIVES)) {
      for (const phrase of SPECIAL_DIRECTIVES[directive]) {
        if (answerline.includes(phrase)) {
          directives.push(directive);
        }
      }
    }

    return directives;
  }

  /* ========== qb-answer-checker src/split-into-sections.js ========== */
  function removeParentheses(string) {
    return string.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '');
  }

  function splitIntoSections(answerline) {
    const mainSection = removeParentheses(answerline);

    let bracketSections = answerline.match(/\[[^\]]*(?=\])/g) ?? [];
    bracketSections = bracketSections.map(section => section.slice(1));
    let parenthesisSections = answerline.match(/\([^)]*(?=\))/g) ?? [];
    parenthesisSections = parenthesisSections.map(section => section.slice(1));

    bracketSections = bracketSections.filter(section => DIRECTIVES_FLATTENED.some(directive => section.startsWith(directive)));
    parenthesisSections = parenthesisSections.filter(section => DIRECTIVES_FLATTENED.some(directive => section.startsWith(directive)));

    return [mainSection, ...bracketSections, ...parenthesisSections];
  }

  /* ====== qb-answer-checker src/split-section-into-clauses.js ====== */
  function getDirective(clause) {
    for (const directive of Object.keys(DIRECTIVES)) {
      for (const phrase of DIRECTIVES[directive]) {
        if (clause.startsWith(phrase)) {
          clause = clause.replace(phrase, '').trim();
          return { directive, clause };
        }
      }
    }

    return { directive: 'accept', clause };
  }

  function getDirectedPrompt(clause) {
    for (const key of ['by asking', 'with']) {
      const index = clause.indexOf(key);
      if (index < 0) { continue; }

      const directedPrompt = utils.extractQuotes(clause.slice(index + key.length));
      clause = clause.slice(0, index).trim();
      return { directedPrompt, clause };
    }

    return { clause };
  }

  function splitSectionIntoParsedClauses(section, isMainAnswer) {
    const clauses = section.split(';').map(clause => clause.trim());
    const regex = isMainAnswer ? /,? or / : /,? or |, /;
    const parsedClauses = [];

    for (let clause of clauses) {
      let directive;
      ({ directive, clause } = getDirective(clause));
      let directedPrompt;
      if (directive === 'prompt') {
        ({ directedPrompt, clause } = getDirectedPrompt(clause));
      }

      let formattedAnswers = clause.split(regex);
      formattedAnswers = formattedAnswers.map(token => token.trim()).filter(token => token.length > 0);
      parsedClauses.push({ directive, formattedAnswers, directedPrompt, isMainAnswer });
    }

    return parsedClauses;
  }

  /* ============= qb-answer-checker src/check-answer.js ============= */
  function normalizeString(string) {
    return string
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // replace special characters
      .toLowerCase()
      .replace(/\(s\)/g, 's') // standardize (s) -> s
      .replace(/["“‟❝”❞]/g, '"') // replace all types of quotes with the same quote
      .replace(/[\u2018-\u201B]/g, '\'') // replace all types of single quotes with the same quote
      .replace(/\p{Pd}/gu, '-') // replace all dashes with the same dash
      .replace(/[\u00B7\u22C5\u2027]/g, '') // interpuncts
      .replace(/<\/?i>/g, ''); // remove italics
  }

  function checkAnswer(answerline, givenAnswer, strictness = 7, verbose = false) {
    if (typeof answerline !== 'string' || typeof givenAnswer !== 'string') {
      return { directive: 'reject', directedPrompt: undefined };
    }

    if (answerline === '' || givenAnswer === '') {
      return { directive: 'reject', directedPrompt: undefined };
    }

    if (typeof strictness !== 'number' || strictness < 0) {
      strictness = 7;
    }

    if (/<b>/.test(answerline) && !/<u>/.test(answerline)) {
      answerline = answerline.replace(/<b>/g, '<u>').replace(/<\/b>/g, '</u>');
    }

    if (answerline.includes('[') && !answerline.includes(']')) {
      answerline = answerline + ']';
    }

    const isFormattedAnswerline = /<u>/.test(answerline);

    answerline = normalizeString(answerline);

    givenAnswer = normalizeString(givenAnswer);
    givenAnswer = utils.removePunctuation(givenAnswer);
    const givenAnswerTokens = tokenize(givenAnswer, true);

    const sections = splitIntoSections(answerline);
    const parsedClauses = sections.flatMap((section, index) => splitSectionIntoParsedClauses(section, index === 0));
    const mainAnswer = parsedClauses[0].formattedAnswers[0];

    if (!isFormattedAnswerline && mainAnswer?.length > 1 && givenAnswer.length === 1 && isNaN(givenAnswer)) {
      return { directive: 'reject' };
    }

    for (const specialDirective of getSpecialDirectives(answerline)) {
      if (specialDirective === 'accept either') {
        parsedClauses.push({ directive: 'accept', formattedAnswers: mainAnswer.split(' ') });
      }

      if (specialDirective === 'prompt on partial') {
        parsedClauses.push({ directive: 'prompt', formattedAnswers: mainAnswer.split(' ') });
      }
    }

    parsedClauses.sort((a, b) => (a.directive === 'reject' ? -1 : 1) - (b.directive === 'reject' ? -1 : 1));

    for (const { directive, formattedAnswers, directedPrompt, isMainAnswer } of parsedClauses) {
      for (const formattedAnswer of formattedAnswers) {
        for (const unformattedAnswer of generateUnformattedAnswers(formattedAnswer, isMainAnswer)) {
          if (unformattedAnswer === '') { continue; }

          const tokens = tokenize(unformattedAnswer, true);
          let matches;

          if (directive === 'reject') {
            matches = unformattedAnswer === givenAnswer;
          } else {
            matches = referenceContainsTokens(
              isFormattedAnswerline ? tokens : givenAnswerTokens,
              isFormattedAnswerline ? givenAnswerTokens : tokens,
              strictness,
              !isFormattedAnswerline,
              true
            );
          }

          if (matches) { return { directive, directedPrompt }; }
        }
      }
    }

    return { directive: 'reject' };
  }

  /* ======================== global export ======================== */
  if (typeof window !== 'undefined') {
    window.qbCheckAnswer = checkAnswer;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { checkAnswer };
  }
})();
