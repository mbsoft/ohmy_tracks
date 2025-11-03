# Omnitracs Stop List Dashboard

A web-based dashboard for parsing and analyzing Omnitracs (Roadnet) stop list reports.

## Features

- Upload XLS/XLSX Omnitracs stop list reports
- Parse multi-row format with route and delivery data
- **Automatic geocoding** of delivery addresses using NextBillion.ai Discover API
- Display routes and deliveries in an organized table
- Export data to CSV format
- Modern, responsive UI

## Installation

### Prerequisites

- Node.js 16+ installed
- npm or yarn

### Setup

1. Install all dependencies:
```bash
npm run install-all
```

This will install dependencies for the root, backend, and frontend.

## Running the Application

### Development Mode

Start both backend and frontend servers concurrently:

```bash
npm run dev
```

This will start:
- Backend API server on http://localhost:5001
- Frontend React app on http://localhost:5173

### Individual Servers

Backend only:
```bash
npm run backend
```

Frontend only:
```bash
npm run frontend
```

## Configuration

### NextBillion API Key

The application uses the NextBillion.ai Discover API for geocoding delivery addresses. By default, it uses the API key 'opensesame'.

To use your own API key, set the environment variable:

```bash
export NEXTBILLION_API_KEY=your_api_key_here
```

Or create a `.env` file in the backend directory:

```
NEXTBILLION_API_KEY=your_api_key_here
```

### Geocoding Cache

The system maintains a local cache of geocoded results to minimize API calls and improve performance:

- **Cache Key**: Uses the `Location ID` from the XLS file
- **Storage**: Persisted to `backend/geocode-cache.json`
- **Behavior**: Automatically checks cache before making API requests
- **Benefits**: 
  - Faster processing for repeat locations
  - Reduced API usage and costs
  - Automatic cache persistence across server restarts

The cache displays statistics after each upload, showing cache hits vs misses.

## Usage

1. Open http://localhost:5173 in your browser
2. Upload an XLS file (like LA.AL.TN.xls) using the file upload interface
3. The system will automatically parse and geocode all delivery addresses
4. View parsed route and delivery data in the table with coordinates
5. Click on routes to expand and see delivery details
6. Export data to CSV using the "Export to CSV" button

## Project Structure

```
ohmy_tracks/
├── backend/
│   ├── package.json      # Backend dependencies
│   ├── server.js         # Express server
│   ├── parser.js         # XLS parsing logic
│   └── geocoding.js      # NextBillion.ai geocoding service
├── frontend/
│   ├── package.json      # Frontend dependencies
│   ├── vite.config.js    # Vite configuration
│   ├── index.html        # HTML entry point
│   └── src/
│       ├── App.jsx       # Main application component
│       ├── components/   # React components
│       └── utils/        # Utility functions
└── package.json          # Root package for scripts
```

## Data Fields Extracted

### Route Level
- Route ID
- Driver Name
- Route Start Time
- Route End Time

### Delivery Level
- Stop Number
- Location ID
- Location Name
- Arrival Time
- Depart Time
- Service Time
- Weight
- Cube
- Gross
- Address
- Phone Number
- Open/Close Time
- Service Windows
- Standard Instructions
- Special Instructions

## Technologies Used

- **Backend**: Node.js, Express, multer (file uploads), xlsx (Excel parsing), axios (HTTP client)
- **Frontend**: React, Vite, TanStack Table, Tailwind CSS
- **Geocoding**: NextBillion.ai Discover API with local caching
- **File Format**: XLS/XLSX

## Troubleshooting

If you encounter issues:

1. Make sure all dependencies are installed: `npm run install-all`
2. Check that ports 5001 and 5173 are available
3. Verify the XLS file format matches Omnitracs stop list reports
4. Check the browser console and backend logs for error messages

## Future Enhancements

- Enhanced parser for different Omnitracs report formats
- Search and filter functionality
- Data visualization (charts, maps)
- Save parsed data to database
- Multi-file batch processing

