import React, { useRef, useState } from 'react';
import { Card, CardContent, Box, Button, Typography, CircularProgress } from '@mui/material';
import { CloudUpload as CloudUploadIcon } from '@mui/icons-material';

function FileUpload({ onFileUpload, loading }) {
  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  };

  const handleChange = (e) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  };

  const handleFile = (file) => {
    const fileName = file.name.toLowerCase();
    if (fileName.endsWith('.xls') || fileName.endsWith('.xlsx')) {
      setSelectedFile(file);
      onFileUpload(file);
    } else {
      alert('Please upload an XLS or XLSX file');
    }
  };

  const handleButtonClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <Card>
      <CardContent>
        <Box
          sx={{
            border: '2px dashed',
            borderColor: dragActive ? 'primary.main' : 'grey.400',
            backgroundColor: dragActive ? 'action.hover' : 'transparent',
            p: 4,
            textAlign: 'center',
            transition: 'border-color 0.3s, background-color 0.3s',
            opacity: loading ? 0.5 : 1,
            pointerEvents: loading ? 'none' : 'auto',
          }}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".xls,.xlsx"
            onChange={handleChange}
            style={{ display: 'none' }}
            disabled={loading}
          />

          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <CloudUploadIcon sx={{ fontSize: 48, color: 'grey.500' }} />

            <Button
              variant="contained"
              onClick={handleButtonClick}
              disabled={loading}
            >
              Choose File
            </Button>

            <Typography variant="body2" color="text.secondary">
              or drag and drop your XLS file here
            </Typography>

            {selectedFile && (
              <Typography variant="body2" color="text.secondary">
                <Typography component="span" fontWeight="medium">Selected file:</Typography> {selectedFile.name}
              </Typography>
            )}

            <Typography variant="caption" color="text.secondary">
              Supported formats: XLS, XLSX (Max 10MB)
            </Typography>
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}

export default FileUpload;


