// Live vehicle make/model/model-number catalog — backed by the Vehicle
// Master Database (GET /vehicle-master/catalog/*), replacing the old static
// assets/car-models.js as the thing pages actually read from. Same shape as
// car-models.js's carGetMakes()/carGetModels()/carGetModelNumbers()/
// carGetBodyType(), but every call is a live, auth-scoped DB query — so a
// newly-approved catalog entry (via vehicle-data-sync.html) shows up
// everywhere immediately, with no static-file regenerate/redeploy step.
// car-models.js itself is untouched and still used for the "download a
// car-models.js snapshot" export on vehicle-data-sync.html.
//
// Every lookup takes an optional trailing `category` — one of
// VEHICLE_CATEGORIES' values below. Omitted means "every category combined"
// (cars, trucks, motorcycles, tractors, tuktuks, special equipment all mixed
// into one list, same as cars/trucks already were before categories existed).
(function () {
  const _cache = { makes: {}, models: {}, modelNumbers: {} };

  async function vehicleCatalogMakes(category) {
    const key = category || "__all__";
    if (_cache.makes[key]) return _cache.makes[key];
    const qs = category ? `?category=${encodeURIComponent(category)}` : "";
    const r = await window.FINEMARK_APP.apiFetch(`/vehicle-master/catalog/makes${qs}`);
    _cache.makes[key] = r?.data || [];
    return _cache.makes[key];
  }

  // Returns [{model, bodyStyle}]
  async function vehicleCatalogModels(make, category) {
    if (!make) return [];
    const key = `${category || "__all__"}||${make.toUpperCase()}`;
    if (_cache.models[key]) return _cache.models[key];
    const qs = category ? `&category=${encodeURIComponent(category)}` : "";
    const r = await window.FINEMARK_APP.apiFetch(`/vehicle-master/catalog/models?make=${encodeURIComponent(make)}${qs}`);
    _cache.models[key] = r?.data || [];
    return _cache.models[key];
  }

  // Returns [{modelNumber, bodyStyle}]
  async function vehicleCatalogModelNumbers(make, model, category) {
    if (!make || !model) return [];
    const key = `${category || "__all__"}||${make.toUpperCase()}||${model.toUpperCase()}`;
    if (_cache.modelNumbers[key]) return _cache.modelNumbers[key];
    const qs = category ? `&category=${encodeURIComponent(category)}` : "";
    const r = await window.FINEMARK_APP.apiFetch(
      `/vehicle-master/catalog/model-numbers?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}${qs}`
    );
    _cache.modelNumbers[key] = r?.data || [];
    return _cache.modelNumbers[key];
  }

  // Single body type for a make+model — derived from the models list, same
  // shape as car-models.js's synchronous carGetBodyType() but async.
  async function vehicleCatalogBodyType(make, model, category) {
    if (!make || !model) return "";
    const models = await vehicleCatalogModels(make, category);
    const match = models.find((m) => m.model === model);
    return match?.bodyStyle || "";
  }

  // Model-line production years for a make+model, derived from the models list.
  // Returns { from, to, label } or null. NOTE: these are model-LINE ranges (when the
  // model line was produced — free-source enrichment: DBpedia/NHTSA), NOT the specific
  // grade/vehicle year (a long-running line like Land Cruiser shows 1951).
  async function vehicleCatalogYears(make, model, category) {
    if (!make || !model) return null;
    const models = await vehicleCatalogModels(make, category);
    const m = models.find((x) => x.model === model);
    if (!m || !m.prodStart) return null;
    return { from: m.prodStart, to: m.prodEnd || null, label: m.prodStart + "–" + (m.prodEnd || "present") };
  }

  window.vehicleCatalogMakes = vehicleCatalogMakes;
  window.vehicleCatalogModels = vehicleCatalogModels;
  window.vehicleCatalogModelNumbers = vehicleCatalogModelNumbers;
  window.vehicleCatalogBodyType = vehicleCatalogBodyType;
  window.vehicleCatalogYears = vehicleCatalogYears;

  // Shared category list for pages that render a Category <select> — value
  // matches vehicle_specs.vehicle_category exactly.
  window.VEHICLE_CATEGORIES = [
    { value: "motor_vehicle", label: "Motor Vehicle (Car/Truck)" },
    { value: "motorcycle", label: "Motorcycle" },
    { value: "tractor", label: "Tractor" },
    { value: "tuktuk", label: "Tuktuk" },
    { value: "special_equipment", label: "Special Equipment" },
    // These three have no make/model/engine spec — see assets/vehicleAttributes.js.
    // Codes must match vehicle_attribute_categories.code exactly.
    { value: "fabricated_body", label: "Fabricated Body" },
    { value: "trailers", label: "Trailers" },
    { value: "special_cargo", label: "Special Cargo" },
  ];

  // Categories backed by the configurable vehicle-attributes module (a single
  // searchable + creatable "Type" instead of Make/Model/Model Number).
  window.VEHICLE_ATTRIBUTE_CATEGORY_CODES = ["fabricated_body", "trailers", "special_cargo"];
})();
