const XLSX = require('xlsx');

/**
 * Parse Omnitracs (Roadnet) stop list XLS report
 * Based on actual file structure analysis
 */
function parseOmnitracXLS(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  
  // Convert sheet to array of arrays
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  
  const routes = [];
  let currentRoute = null;
  let inDeliverySection = false;
  let i = 0;
  
  // Variable to track if we've encountered Equipment Type header
  let equipmentTypeHeaderFound = false;

  // Define the list of equipment types to detect
  const equipmentTypes = ['14BAY', '32LG', '28LG', '40LG', '18BT', '48LG', '48FT'];

  while (i < data.length) {
    const row = data[i];
    const firstCell = String(row[0] || '').trim();
    
    // Reset equipmentType found for each route
    if (firstCell.startsWith('Route Id:')) {
      if (currentRoute) {
        routes.push(currentRoute);
      }
      currentRoute = {
        routeId: firstCell.match(/Route Id:\s*(.+)/)?.[1].trim() || '',
        driverId: '',
        driverName: '',
        equipmentType: '',
        routeStartTime: '',
        routeEndTime: '',
        deliveries: []
      };
      equipmentTypeHeaderFound = false;
    }

    // Check for equipment types in the list
    const equipmentCell = String(row[8] || '').trim();
    if (equipmentTypes.some(type => equipmentCell.startsWith(type)) && !currentRoute.equipmentType) {
      currentRoute.equipmentType = equipmentCell;
    }
    
    // Look for Driver (independent of equipment parsing; both can exist on the same row)
    if (currentRoute && !currentRoute.driverId && firstCell.match(/^[A-Z\d]{2,}:\s*/)) {
      // Formats like "ZZ12250071:  Jamille Talley"
      const m = firstCell.match(/^([A-Z\d]+):\s*(.+)$/);
      if (currentRoute && m) {
        currentRoute.driverId = m[1].trim();
        currentRoute.driverName = m[2].trim();
      }
    }
    
    // Look for Route Start Time
    if (firstCell.startsWith('Route Start Time:')) {
      const timeMatch = firstCell.match(/Route Start Time:\s*(.+)/);
      if (currentRoute && timeMatch) {
        currentRoute.routeStartTime = timeMatch[1].trim();
      }
    }
    
    // Look for Route Complete Time
    if (firstCell.startsWith('Route Complete Time:')) {
      const timeMatch = firstCell.match(/Route Complete Time:\s*(.+)/);
      if (currentRoute && timeMatch) {
        currentRoute.routeEndTime = timeMatch[1].trim();
      }
    }
    
    // Look for header row (indicates delivery section starts)
    if (firstCell === 'Stop' && String(row[1] || '').includes('Location')) {
      inDeliverySection = true;
    }
    
    // Parse delivery data (stop number in first column)
    if (inDeliverySection && currentRoute && /^\d+$/.test(firstCell)) {
      const delivery = parseDelivery(data, i);
      if (delivery) {
        currentRoute.deliveries.push(delivery);
      }
    }
    // Parse Paid Break line item (same row contains start, end, duration)
    if (inDeliverySection && currentRoute) {
      const locationNameCell = String(row[3] || '').trim();
      const isPaidBreak = firstCell.toLowerCase().startsWith('paid break') || locationNameCell.toLowerCase().startsWith('paid break');
      if (isPaidBreak) {
        const arrivalRaw = String(row[8] || '').trim();
        const arrival = arrivalRaw.includes('/') ? arrivalRaw.split('/')[0].trim() : arrivalRaw;
        const departRaw = String(row[11] || '').trim();
        const depart = departRaw.includes('/') ? departRaw.split('/')[0].trim() : departRaw;
        const service = String(row[13] || '').trim(); // duration field on the same row

        currentRoute.deliveries.push({
          stopNumber: '',
          locationId: '',
          locationName: 'Paid Break',
          arrival,
          depart,
          service,
          weight: '',
          cube: '',
          gross: '',
          address: '',
          phoneNumber: '',
          openCloseTime: '',
          serviceWindows: '',
          standardInstructions: '',
          specialInstructions: '',
          isBreak: true
        });
      }
      // Parse Depot resupply row (e.g., "Depot ...", next line has address and CS/PAL/WGT)
      else if (String(firstCell).toLowerCase() === 'depot') {
        const arrivalRaw = String(row[8] || '').trim();
        const arrival = arrivalRaw.includes('/') ? arrivalRaw.split('/')[0].trim() : arrivalRaw;
        const departRaw = String(row[11] || '').trim();
        const depart = departRaw.includes('/') ? departRaw.split('/')[0].trim() : departRaw;
        const service = String(row[13] || '').trim();
        // The primary row often shows 0.00 for pallets/weight; actual pickup appears on the next "Address" row.
        // Try to read from the next row; fall back to current row if not found.
        const nextRow = data[i + 1] || [];
        const address = String(nextRow[1] || '').trim();
        // Extract ordered numeric tokens from the next row; the final three are typically CS, PAL, WGT
        const numsOrdered = [];
        for (const cell of nextRow) {
          const s = String(cell || '');
          const matches = s.match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/g);
          if (matches) {
            for (const token of matches) {
              const n = Number(String(token).replace(/,/g, ''));
              if (Number.isFinite(n)) numsOrdered.push(n);
            }
          }
        }
        let pallets = String(row[18] || '').trim();
        let weightFromNext = '';
        if (numsOrdered.length >= 3) {
          // Take the last three numeric tokens as [CS, PAL, WGT]
          const cs = numsOrdered[numsOrdered.length - 3];
          const pal = numsOrdered[numsOrdered.length - 2];
          const wgt = numsOrdered[numsOrdered.length - 1];
          if (Number.isFinite(pal)) pallets = String(Math.round(pal));
          if (Number.isFinite(wgt)) weightFromNext = String(Math.round(wgt));
        } else {
          // Fallback: choose the largest as weight and last small integer as pallets
          const palletCand = numsOrdered.filter((n) => n > 0 && n <= 100);
          if (palletCand.length) pallets = String(Math.round(palletCand[palletCand.length - 1]));
          const weightCand = numsOrdered.filter((n) => n >= 1000);
          if (weightCand.length) weightFromNext = String(Math.round(weightCand.sort((a,b)=>a-b)[weightCand.length - 1]));
        }
        // Prefer the canonical PAL/WGT columns if present on the next row
        const palCol = String(nextRow[18] || '').trim();
        const wgtCol = String(nextRow[20] || '').trim();
        const palColNum = Number(String(palCol).replace(/,/g, ''));
        const wgtColNum = Number(String(wgtCol).replace(/,/g, ''));
        if (Number.isFinite(palColNum) && palColNum > 0) pallets = String(Math.round(palColNum));
        if (Number.isFinite(wgtColNum) && wgtColNum > 0) weightFromNext = String(Math.round(wgtColNum));
        const gross = String(row[20] || '').trim();
        let weight = weightFromNext || (gross ? gross.replace(/,/g, '') : '');

        currentRoute.deliveries.push({
          stopNumber: '',
          locationId: String(row[1] || '').trim(),
          locationName: locationNameCell || 'Depot',
          arrival,
          depart,
          service,
          weight,
          cube: pallets,
          gross: gross,
          address,
          phoneNumber: '',
          openCloseTime: '',
          serviceWindows: '',
          standardInstructions: '',
          specialInstructions: '',
          isDepotResupply: true
        });
      }
    }
    
    i++;
  }
  
  // Save last route
  if (currentRoute) {
    routes.push(currentRoute);
  }
  
  return {
    routes: routes,
    totalRoutes: routes.length,
    totalDeliveries: routes.reduce((sum, route) => sum + route.deliveries.length, 0)
  };
}

/**
 * Parse a delivery that spans multiple rows
 * Row structure based on actual file:
 * Row 0: Stop#, Location ID, blank, Location Name, blanks, Arrival, blanks, Depart, blank, Service, blanks, Weight, blank, Cube, blank, Gross
 * Row 1: blank, Address (with phone sometimes), blanks, Phone, blanks, Weight, blank, Cube, blank, Gross
 *        OR blank row if address is on row 2
 * Row 2: blank, Open/Close Time OR Address (if not on row 1), blanks, Service Windows
 * Row 3: blank, Open/Close Time (if address was on row 2), blanks, Service Windows
 */
function parseDelivery(data, startRow) {
  const row1 = data[startRow] || [];
  const row2 = data[startRow + 1] || [];
  const row3 = data[startRow + 2] || [];
  const row4 = data[startRow + 3] || [];
  
  // First row - main delivery info
  const stopNumber = String(row1[0] || '').trim();
  const locationId = String(row1[1] || '').trim();
  const locationName = String(row1[3] || '').trim();
  
  // Clean arrival and depart times - remove "/" and anything after it
  const arrivalRaw = String(row1[8] || '').trim();
  const arrival = arrivalRaw.includes('/') ? arrivalRaw.split('/')[0].trim() : arrivalRaw;
  
  const departRaw = String(row1[11] || '').trim();
  const depart = departRaw.includes('/') ? departRaw.split('/')[0].trim() : departRaw;
  
  const service = String(row1[13] || '').trim();
  let weight = String(row1[15] || '').trim();
  const cube = String(row1[18] || '').trim();
  const gross = String(row1[20] || '').trim();
  // Prefer the 'gross' column for weight if present (e.g., 2,370.14)
  if (gross && gross.length > 0) {
    weight = gross.replace(/,/g, '');
  }
  // Round weight to one decimal place
  const weightNum = parseFloat((weight || '').replace(/,/g, ''));
  if (!isNaN(weightNum)) {
    weight = weightNum.toFixed(1);
  }
  
  // Address can be in row2 or row3 - check both
  // Row2 typically has the address, but sometimes there's an extra row
  const address2 = String(row2[1] || '').trim();
  const address3 = String(row3[1] || '').trim();
  
  // Determine which row has the address
  // Address typically contains numbers and street indicators
  const addressLooksLike = (str) => {
    if (!str || str.length === 0) return false;
    // Check if it looks like an address (contains numbers and street words)
    const hasNumber = /\d/.test(str);
    const hasStreetIndicator = /(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|pkwy|parkway|ln|lane|way|ct|court|pl|place)/i.test(str);
    const notOpenClose = !str.toLowerCase().includes('open') && !str.toLowerCase().includes('close');
    return hasNumber && (hasStreetIndicator || str.length > 10) && notOpenClose;
  };
  
  let address = '';
  let phoneRow = row2;
  let openCloseRow = row3;
  let serviceWindowsRow = row3;
  
  if (addressLooksLike(address2)) {
    address = address2;
    phoneRow = row2;
    openCloseRow = row3;
    serviceWindowsRow = row3;
  } else if (addressLooksLike(address3)) {
    // Address found in row 3
    address = address3;
    phoneRow = row3;
    openCloseRow = row4;
    serviceWindowsRow = row4;
    console.log(`  📍 Address found in row 3 for ${locationName}: ${address}`);
  } else if (address2) {
    // Default to row2 if it has any content
    address = address2;
    phoneRow = row2;
    openCloseRow = row3;
    serviceWindowsRow = row3;
  }
  
  // Phone number
  const phoneMatch = String(phoneRow[12] || '').match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  const phoneNumber = phoneMatch ? phoneMatch[0] : '';
  
  // Open/close time and service windows
  const openCloseTime = String(openCloseRow[1] || '').trim();
  const serviceWindows = String(serviceWindowsRow[9] || '').trim();
  
  // Look for instructions in following rows
  // Instructions can be in different rows depending on where the address was
  let standardInstructions = '';
  let specialInstructions = '';
  
  // Check up to 2 rows after the service windows row
  const instructionRows = [
    data[startRow + 3] || [],
    data[startRow + 4] || [],
    data[startRow + 5] || []
  ];
  
  for (const row of instructionRows) {
    const firstCell = String(row[0] || '').trim();
    
    if (firstCell === 'Standard Instructions' || firstCell.toLowerCase().includes('standard instruction')) {
      standardInstructions = String(row[9] || '').trim();
      break;
    } else if (firstCell.toLowerCase().includes('special instruction')) {
      specialInstructions = String(row[9] || '').trim();
      break;
    } else if (firstCell.toLowerCase().includes('instruction') && !standardInstructions) {
      standardInstructions = firstCell;
    }
  }
  
  return {
    stopNumber,
    locationId,
    locationName,
    arrival,
    depart,
    service,
    weight,
    cube,
    gross,
    address,
    phoneNumber,
    openCloseTime,
    serviceWindows,
    standardInstructions,
    specialInstructions
  };
}

/**
 * Parse POC_* XLSX format (header-based, flat table)
 * Heuristics to map columns and group by route/vehicle.
 */
function parsePocXLS(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!Array.isArray(rows) || rows.length === 0) {
    return { routes: [], totalRoutes: 0, totalDeliveries: 0 };
  }
  // Build a lower-case key map for header lookup
  const headerKeys = Object.keys(rows[0] || {});
  const lowerMap = new Map(headerKeys.map(k => [k.toLowerCase(), k]));
  const exactKey = (...cands) => {
    for (const c of cands) {
      const k = lowerMap.get(String(c).toLowerCase());
      if (k) return k;
    }
    return null;
  };
  const findKey = (...cands) => {
    for (const c of cands) {
      const k = lowerMap.get(String(c).toLowerCase());
      if (k) return k;
    }
    // fuzzy contains
    for (const k of headerKeys) {
      const kl = k.toLowerCase();
      if (cands.some(c => kl.includes(String(c).toLowerCase()))) return k;
    }
    return null;
  };
  // Prefer explicit POC headers where provided - STRICT for route to avoid matching "Day"
  const routeKey =
    exactKey('Route', 'Route #', 'Route#', 'Route Id', 'Route ID') ||
    null; // do not fallback to fuzzy for route to avoid accidental matches (e.g., "Day")
  const stopKey = findKey('Stop', 'stop', 'stop #', 'stop no', 'sequence', 'seq');
  const locIdKey = findKey('Location Id', 'location id', 'customer id', 'store #', 'store', 'id', 'ship-to id', 'ship to id');
  const nameKey = findKey('Ship-To Name', 'ship-to name', 'location name', 'customer', 'name', 'account');
  const addr1Key = findKey('Address', 'address line 1', 'address1', 'street', 'addr1');
  const addr2Key = findKey('Address Line 2', 'address line 2', 'address2', 'addr2');
  const cityKey = findKey('City', 'city', 'town');
  const stateKey = findKey('State', 'state', 'st');
  const zipKey = findKey('Zip Code', 'zip code', 'zip', 'zipcode', 'postal');
  const arriveKey = findKey('Arrival', 'arrival', 'arrive', 'eta', 'nb_arrival');
  const departKey = findKey('Depart', 'depart', 'departure', 'nb_depart');
  const earliestKey = findKey('Earliest time', 'earliest', 'earliest window', 'time window start', 'start window');
  const latestKey = findKey('Latest time', 'latest', 'latest window', 'time window end', 'end window');
  const dayKey = findKey('Day', 'day of week', 'dow', 'route day');
  const customerNumKey = findKey('Customer Number', 'customer number', 'customer #', 'cust #', 'customernumber', 'cust no', 'customer id');
  const shipToNumKey = findKey('Ship-To Number', 'ship-to number', 'ship to number', 'ship-to #', 'ship to #', 'shipto number', 'ship-to id', 'ship to id');
  const serviceKey = findKey('Service', 'service', 'service time', 'duration', 'svc');
  const palletsKey = findKey('Pallets', 'pallets', 'cube', 'cases/pallets', 'cs/pal', 'pal');
  const weightKey = findKey('Weight', 'weight', 'wgt', 'lbs');
  const driverKey = findKey('Driver', 'driver', 'driver name', 'drivername');
  const equipKey = findKey('Equipment', 'equipment', 'equipment type', 'equip');
  const startKey = findKey('Route Start Time', 'route start time', 'start time', 'start');
  const endKey = findKey('Route Complete Time', 'route complete time', 'end time', 'end');
  const locationKey = findKey('Location', 'Plant', 'Depot', 'Warehouse');
  // Group rows by route
  const routeIdFor = (row) => {
    // If no strict routeKey found, keep single UNSPECIFIED group
    if (!routeKey) return 'UNSPECIFIED';
    const raw = String(row[routeKey] || '').trim();
    // Only accept a route id that looks like a code (keep leading zeros)
    // Accept non-empty strings, reject obvious header echoes like "Day"
    if (!raw) return 'UNSPECIFIED';
    if (/^day$/i.test(raw)) return 'UNSPECIFIED';
    // If purely numeric, normalize by integer value so "055" === "55"
    if (/^\d+$/.test(raw)) {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? String(n) : raw;
    }
    return raw;
  };
  const byRouteId = new Map();
  for (const row of rows) {
    const rId = routeIdFor(row);
    if (!byRouteId.has(rId)) byRouteId.set(rId, []);
    byRouteId.get(rId).push(row);
  }
  const routes = [];
  for (const [rId, rRows] of byRouteId.entries()) {
    const route = {
      routeId: rId,
      driverId: '',
      driverName: driverKey ? String(rRows[0]?.[driverKey] || '').trim() : '',
      equipmentType: equipKey ? String(rRows[0]?.[equipKey] || '').trim() : '',
      routeStartTime: startKey ? String(rRows[0]?.[startKey] || '').trim() : '',
      routeEndTime: endKey ? String(rRows[0]?.[endKey] || '').trim() : '',
      location: locationKey ? String(rRows[0]?.[locationKey] || '').trim() : '',
      deliveries: []
    };
    for (const row of rRows) {
      // Skip empty or header-like rows
      const stopVal = stopKey ? String(row[stopKey] || '').trim() : '';
      const nameVal = nameKey ? String(row[nameKey] || '').trim() : '';
      const addr1 = addr1Key ? String(row[addr1Key] || '').trim() : '';
      const city = cityKey ? String(row[cityKey] || '').trim() : '';
      const state = stateKey ? String(row[stateKey] || '').trim() : '';
      const zip = zipKey ? String(row[zipKey] || '').toString().trim() : '';
      const looksLikeStop = stopVal !== '' || nameVal !== '' || addr1 !== '' || city !== '';
      if (!looksLikeStop) continue;
      // Normalize Day-of-week token (M/T/W/R/F)
      const dayRaw = dayKey ? String(row[dayKey] || '').trim().toUpperCase() : '';
      const dayToken = (() => {
        if (!dayRaw) return '';
        const c = dayRaw[0];
        return ['M', 'T', 'W', 'R', 'F'].includes(c) ? c : '';
      })();
      const addressParts = [];
      if (addr1) addressParts.push(addr1);
      const addr2 = addr2Key ? String(row[addr2Key] || '').trim() : '';
      // For POC geocoding, primary address is Address, City, State Zip
      const cityStateZip = [city, state, zip].filter(Boolean).join(', ').replace(/,\s+(\d)/, ' $1');
      // Build open/close time window from Earliest/Latest time with defaults (Earliest=09:00, Latest=16:00)
      const rawEarliest = earliestKey ? String(row[earliestKey] || '').trim() : '';
      const rawLatest = latestKey ? String(row[latestKey] || '').trim() : '';
      const normalizeTime = (val, fallback, opts = { isEarliest: false }) => {
        const v = String(val || '').trim();
        if (!v) return fallback;
        // Accept formats: "H", "HH", "H:MM", "HH:MM"
        const m = v.match(/^(\d{1,2})(?::(\d{2}))?$/);
        if (!m) return fallback;
        let h = parseInt(m[1], 10);
        let min = m[2] ? parseInt(m[2], 10) : 0;
        if (!Number.isFinite(h) || h < 0 || h > 23) return fallback;
        if (!Number.isFinite(min) || min < 0 || min > 59) return fallback;
        // For earliest window times: always treat as AM; 6 => 06:00
        // For latest window times: interpret 1-6 as afternoon (13:00-18:59), 7-12 as morning/noon
        if (!opts.isEarliest) {
          if (h >= 1 && h <= 6) h += 12;
        }
        // 7..12 kept as-is (07:xx..12:xx), >12 assumed 24h input
        const hh = h.toString().padStart(2, '0');
        const mm = min.toString().padStart(2, '0');
        return `${hh}:${mm}`;
      };
      const earliestHHMM = normalizeTime(rawEarliest, '09:00', { isEarliest: true });
      const latestHHMM = normalizeTime(rawLatest, '16:00', { isEarliest: false });
      const openClose = `${earliestHHMM} - ${latestHHMM}`;
      const delivery = {
        stopNumber: stopVal,
        // Prefer a stable location id; fall back to name or address tuple
        locationId: (() => {
          const id = locIdKey ? String(row[locIdKey] || '').trim() : '';
          if (id) return id;
          if (nameVal) return nameVal;
          const synthetic = [addr1, city, state, zip].filter(Boolean).join('|');
          return synthetic || '';
        })(),
        locationName: nameVal,
        day: dayToken,
        customerNumber: customerNumKey ? String(row[customerNumKey] || '').trim() : '',
        shipToNumber: shipToNumKey ? String(row[shipToNumKey] || '').trim() : '',
        arrival: arriveKey ? String(row[arriveKey] || '').trim() : '',
        depart: departKey ? String(row[departKey] || '').trim() : '',
        service: serviceKey ? String(row[serviceKey] || '').trim() : '',
        weight: weightKey ? String(row[weightKey] || '').toString().replace(/,/g, '') : '',
        cube: palletsKey ? String(row[palletsKey] || '').trim() : '',
        gross: '', // not typically present in POC; keep empty
        // Geocoding address per requirement: Address, City, State Zip
        address: [addr1, cityStateZip].filter(Boolean).join(', ').trim(),
        phoneNumber: '',
        openCloseTime: openClose, // derived from Earliest/Latest time or defaults
        serviceWindows: '',
        standardInstructions: '',
        specialInstructions: ''
      };
      // Annotate paid break if name suggests it
      if (String(delivery.locationName || '').toLowerCase().includes('break')) {
        delivery.isBreak = true;
      }
      route.deliveries.push(delivery);
    }
    // For POC routes, set routeStartTime based on day letter in deliveries for week of Oct 5, 2025
    const dow = (route.deliveries.find((d) => !!d.day)?.day) || '';
    if (dow) {
      const baseDateByDay = { M: '10/06/2025', T: '10/07/2025', W: '10/08/2025', R: '10/09/2025', F: '10/10/2025' };
      const dateStr = baseDateByDay[dow];
      if (dateStr) {
        route.routeStartTime = `${dateStr} 04:00 EDT`;
        route.routeEndTime = `${dateStr} 23:59 EDT`;
      }
    }
    routes.push(route);
  }
  return {
    routes,
    totalRoutes: routes.length,
    totalDeliveries: routes.reduce((sum, r) => sum + r.deliveries.length, 0)
  };
}

module.exports = { parseOmnitracXLS, parsePocXLS };

