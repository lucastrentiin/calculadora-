/*
 * Offline unit conversion. Every factor converts the unit to the SI (or
 * coherent) base unit of its category. Sources: exact definitions of the SI
 * brochure / NIST SP 811 (international yard and pound 1959, US survey units
 * not used, thermochemical calorie 4.184 J, IT BTU, standard atmosphere,
 * eV 2019 SI exact value). Temperature is affine and handled separately.
 * tools/gen_tables_c.js generates the C table from this file.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./mathEngine.js'));
  else { root.MT = root.MT || {}; root.MT.Units = factory(root.MT.MathEngine); }
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  const CATEGORIES = [
    { id: 'length', name: 'Comprimento', base: 'm', units: [
      ['mm', 'milimetro', 1e-3], ['cm', 'centimetro', 1e-2], ['m', 'metro', 1], ['km', 'quilometro', 1e3],
      ['um', 'micrometro', 1e-6], ['in', 'polegada', 0.0254], ['ft', 'pe', 0.3048], ['yd', 'jarda', 0.9144],
      ['mi', 'milha', 1609.344], ['nmi', 'milha nautica', 1852]] },
    { id: 'area', name: 'Area', base: 'm2', units: [
      ['mm2', 'mm quadrado', 1e-6], ['cm2', 'cm quadrado', 1e-4], ['m2', 'm quadrado', 1], ['km2', 'km quadrado', 1e6],
      ['ha', 'hectare', 1e4], ['in2', 'pol. quadrada', 0.00064516], ['ft2', 'pe quadrado', 0.09290304],
      ['yd2', 'jarda quadrada', 0.83612736], ['acre', 'acre', 4046.8564224], ['mi2', 'milha quadrada', 2589988.110336]] },
    { id: 'volume', name: 'Volume', base: 'm3', units: [
      ['mL', 'mililitro', 1e-6], ['L', 'litro', 1e-3], ['cm3', 'cm cubico', 1e-6], ['m3', 'm cubico', 1],
      ['in3', 'pol. cubica', 1.6387064e-5], ['ft3', 'pe cubico', 0.028316846592], ['galUS', 'galao EUA', 0.003785411784],
      ['galUK', 'galao imperial', 0.00454609], ['qtUS', 'quarto EUA', 0.000946352946], ['flozUS', 'onca liq. EUA', 2.95735295625e-5]] },
    { id: 'mass', name: 'Massa', base: 'kg', units: [
      ['mg', 'miligrama', 1e-6], ['g', 'grama', 1e-3], ['kg', 'quilograma', 1], ['t', 'tonelada', 1e3],
      ['lb', 'libra', 0.45359237], ['oz', 'onca', 0.028349523125], ['st', 'stone', 6.35029318]] },
    { id: 'temperature', name: 'Temperatura', base: 'K', affine: true, units: [
      ['C', 'Celsius', null], ['F', 'Fahrenheit', null], ['K', 'Kelvin', null], ['R', 'Rankine', null]] },
    { id: 'speed', name: 'Velocidade', base: 'm/s', units: [
      ['m/s', 'metro/segundo', 1], ['km/h', 'km/hora', 1 / 3.6], ['mph', 'milha/hora', 0.44704],
      ['kn', 'no', 1852 / 3600], ['ft/s', 'pe/segundo', 0.3048]] },
    { id: 'time', name: 'Tempo', base: 's', units: [
      ['ms', 'milissegundo', 1e-3], ['s', 'segundo', 1], ['min', 'minuto', 60], ['h', 'hora', 3600],
      ['d', 'dia', 86400], ['sem', 'semana', 604800], ['ano', 'ano juliano', 31557600]] },
    { id: 'pressure', name: 'Pressao', base: 'Pa', units: [
      ['Pa', 'pascal', 1], ['kPa', 'quilopascal', 1e3], ['MPa', 'megapascal', 1e6], ['bar', 'bar', 1e5],
      ['atm', 'atmosfera', 101325], ['mmHg', 'mm de mercurio', 133.322387415], ['Torr', 'torr', 101325 / 760],
      ['psi', 'psi', 6894.757293168361]] },
    { id: 'energy', name: 'Energia', base: 'J', units: [
      ['J', 'joule', 1], ['kJ', 'quilojoule', 1e3], ['cal', 'caloria', 4.184], ['kcal', 'quilocaloria', 4184],
      ['Wh', 'watt-hora', 3600], ['kWh', 'quilowatt-hora', 3.6e6], ['eV', 'eletron-volt', 1.602176634e-19],
      ['BTU', 'BTU (IT)', 1055.05585262]] },
    { id: 'angle', name: 'Angulo', base: 'rad', units: [
      ['rad', 'radiano', 1], ['deg', 'grau', Math.PI / 180], ['grad', 'grado', Math.PI / 200],
      ['rev', 'volta', 2 * Math.PI], ['arcmin', 'minuto de arco', Math.PI / 10800], ['arcsec', 'segundo de arco', Math.PI / 648000]] }
  ];

  const TEMP = {
    C: { toK: x => x + 273.15, fromK: k => k - 273.15, formula: 'K = C + 273,15' },
    F: { toK: x => (x - 32) * 5 / 9 + 273.15, fromK: k => (k - 273.15) * 9 / 5 + 32, formula: 'K = (F - 32)*5/9 + 273,15' },
    K: { toK: x => x, fromK: k => k, formula: 'K = K' },
    R: { toK: x => x * 5 / 9, fromK: k => k * 9 / 5, formula: 'K = R*5/9' }
  };

  function category(id) {
    const c = CATEGORIES.find(c => c.id === id);
    if (!c) throw new Error('categoria desconhecida: ' + id);
    return c;
  }

  function unit(cat, sym) {
    const u = cat.units.find(u => u[0] === sym);
    if (!u) throw new Error('unidade desconhecida: ' + sym);
    return u;
  }

  function convert(catId, from, to, value) {
    const cat = category(catId);
    unit(cat, from); unit(cat, to);
    if (!isFinite(value)) throw new Error('valor invalido');
    if (cat.affine) {
      const k = TEMP[from].toK(value);
      if (k < 0) throw new M.MathError(M.ERR.DOMAIN, 'abaixo do zero absoluto');
      return TEMP[to].fromK(k);
    }
    const f1 = unit(cat, from)[2], f2 = unit(cat, to)[2];
    const r = value * f1 / f2;
    // remove binary floating point noise (e.g. 2.54 * 100 -> 254.00000000000003)
    return Number(r.toPrecision(14));
  }

  /** Human readable explanation lines. */
  function explain(catId, from, to, value) {
    const cat = category(catId);
    const result = convert(catId, from, to, value);
    const f = M.formatNumber;
    if (cat.affine) {
      const k = TEMP[from].toK(value);
      return { result, steps: [
        `${f(value)} ${from} -> ${f(k)} K`,
        TEMP[from].formula,
        `${f(k)} K -> ${f(result)} ${to}`
      ] };
    }
    const f1 = unit(cat, from)[2], f2 = unit(cat, to)[2];
    return { result, steps: [
      `1 ${from} = ${f(f1)} ${cat.base}`,
      `1 ${to} = ${f(f2)} ${cat.base}`,
      `${f(value)} * ${f(f1)} / ${f(f2)}`,
      `= ${f(result)} ${to}`
    ] };
  }

  return { CATEGORIES, convert, explain, category };
});
