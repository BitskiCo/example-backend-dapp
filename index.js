require('dotenv').config();
const App = require('./app/app');

const credentials = {
  id: process.env.BITSKI_APP_WALLET_ID,
  secret: process.env.BITSKI_APP_WALLET_SECRET
};

const app = new App(credentials.id, 'rinkeby', credentials);
app.start(process.env.PORT || 3000);
