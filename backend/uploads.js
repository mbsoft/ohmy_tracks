const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const uploadsDir = path.join(__dirname, 'uploads');

// Ensure the uploads directory exists
async function init() {
  try {
    await fs.mkdir(uploadsDir, { recursive: true });
  } catch (error) {
    console.error('Error creating uploads directory:', error);
  }
}

init();

async function saveUpload(fileName, data) {
  const id = uuidv4();
  const filePath = path.join(uploadsDir, `${id}.json`);
  const uploadData = {
    id,
    fileName,
    createdAt: new Date().toISOString(),
    data,
  };
  await fs.writeFile(filePath, JSON.stringify(uploadData, null, 2));
  return uploadData;
}

async function getUploads() {
  const files = await fs.readdir(uploadsDir);
  const uploads = [];
  for (const file of files) {
    if (path.extname(file) === '.json') {
      const filePath = path.join(uploadsDir, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const { id, fileName, createdAt } = JSON.parse(content);
      uploads.push({ id, fileName, createdAt });
    }
  }
  // Sort by creation date, newest first
  return uploads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function getUpload(id) {
  const filePath = path.join(uploadsDir, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function deleteUpload(id) {
  const filePath = path.join(uploadsDir, `${id}.json`);
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

module.exports = {
  saveUpload,
  getUploads,
  getUpload,
  deleteUpload,
};
