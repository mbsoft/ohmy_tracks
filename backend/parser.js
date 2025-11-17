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

module.exports = { parseOmnitracXLS };

