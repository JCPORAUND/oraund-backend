// lib/order-summary.js — distill Cafe24 order list into a small AI-friendly summary.
// Used by both /api/cafe24/me/orders (caching) and /api/chat (context injection).

const BEAN_KEYWORDS = {
  und:        ['운트', 'UND BLEND'],
  backerei:   ['베커라이', 'BACKEREI'],
  also:       ['알소', 'ALSO BLEND'],
  aricha:     ['아리차'],
  guji:       ['구지', 'GUJI'],
  akatenango: ['아카테낭고'],
  suprimo:    ['수프리모', 'SUPRIMO'],
  paraiso:    ['파라이소', 'PARAISO'],
  embu:       ['엠부', 'EMBU'],
  huehue:     ['우에우에테낭고', 'HUEHUE'],
  coldecaf:   ['콜롬비아 디카페인', 'COLOMBIA DECAF'],
  weilharf:   ['바일', 'WEIL HARF'],
  washed:     ['워시드', 'WASHED'],
  neighbor:   ['이웃', 'NEIGHBOR'],
  zacaffe:    ['자카페', 'ZACAFFE'],
  paca:       ['파카마라', 'PACAMARA'],
  santa:      ['산타테레사', 'SANTA TERESA'],
};

const TASTE_OF_BEAN = {
  und: '고소', backerei: '고소', suprimo: '고소', huehue: '고소', santa: '고소',
  also: '산뜻', aricha: '산뜻', guji: '산뜻', akatenango: '산뜻', paraiso: '산뜻', washed: '산뜻',
  neighbor: '달콤', embu: '달콤', paca: '달콤',
  coldecaf: '디카페인', weilharf: '디카페인',
  zacaffe: '자카페',
};

function detectBean(productName, optionValue) {
  const text = `${productName || ''} ${optionValue || ''}`.toLowerCase();
  for (const [id, keywords] of Object.entries(BEAN_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw.toLowerCase()))) return id;
  }
  return null;
}

function summariseOrders(orders) {
  const beanCounts = {};
  const tasteCounts = {};
  let totalItems = 0;
  let lastOrderDate = null;

  for (const o of orders || []) {
    if (!lastOrderDate || (o.ordered_at && o.ordered_at > lastOrderDate)) lastOrderDate = o.ordered_at;
    for (const it of o.items || []) {
      const beanId = detectBean(it.product_name, it.option_value);
      if (!beanId) continue;
      const qty = parseFloat(it.quantity) || 1;
      beanCounts[beanId] = (beanCounts[beanId] || 0) + qty;
      const taste = TASTE_OF_BEAN[beanId];
      if (taste) tasteCounts[taste] = (tasteCounts[taste] || 0) + qty;
      totalItems += qty;
    }
  }

  const topBeans = Object.entries(beanCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, qty]) => ({ id, qty }));

  const dominantTaste = Object.entries(tasteCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    order_count: (orders || []).length,
    total_items: totalItems,
    last_order_date: lastOrderDate,
    top_beans: topBeans,
    taste_distribution: tasteCounts,
    dominant_taste: dominantTaste,
  };
}

module.exports = { summariseOrders, detectBean, BEAN_KEYWORDS, TASTE_OF_BEAN };
