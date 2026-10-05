/* search-worker.js — build product indexes off the main thread */
self.onmessage = function (e) {
  var data = e.data || {};
  if (data.type !== 'build') return;
  var records = data.records || [];
  var id = data.id;
  var products = [];
  var bySku = Object.create(null);
  var byBarcode = Object.create(null);
  var bySuffix6 = Object.create(null);
  var nameSearch = [];
  for (var i = 0; i < records.length; i++) {
    var r = records[i] || {};
    var barcodes = Array.isArray(r.barcodes) ? r.barcodes.map(String) : [];
    var p = {
      id: i,
      sku: String(r.sku || ''),
      name: r.name || 'Unnamed product',
      barcodes: barcodes,
      image: r.image || ''
    };
    products.push(p);
    if (p.sku) bySku[p.sku] = i;
    for (var j = 0; j < barcodes.length; j++) {
      var bc = barcodes[j];
      if (!bc) continue;
      if (!byBarcode[bc]) byBarcode[bc] = [];
      byBarcode[bc].push(i);
      if (bc.length >= 6) {
        var suf = bc.slice(-6);
        if (!bySuffix6[suf]) bySuffix6[suf] = [];
        bySuffix6[suf].push(i);
      }
    }
    nameSearch.push({ i: i, lowerName: p.name.toLowerCase() });
  }
  self.postMessage({
    id: id,
    products: products,
    bySku: bySku,
    byBarcode: byBarcode,
    bySuffix6: bySuffix6,
    nameSearch: nameSearch
  });
};
