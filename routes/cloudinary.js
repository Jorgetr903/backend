const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: 'dh64ukd7g', 
  api_key: '144478994286528',
  api_secret: 'wczup3bjpfQ8PzyDTiD0LC5Dowk',
});

module.exports = cloudinary;
