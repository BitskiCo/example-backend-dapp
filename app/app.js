const Express = require('express');
const cors = require('cors');
const Web3 = require('web3');
const Bitski = require('bitski-node');
const Contract = require('./contract');
const artifacts = require('../build/contracts/LimitedMintableNonFungibleToken');
const BN = require('bn.js');

class App {

  /**
   * Creates a new instance of App
   * @param {string} clientId Your Bitski client id
   * @param {string} network The network name to use (mainnet | kovan | rinkeby)
   * @param {object} credentials Your app wallet credentials
   * @param {string} credentials.id Your credential id
   * @param {string} credentials.secret Your credential secret
   */
  constructor(clientId, network, credentials) {
    const options = {
      credentials: credentials,
      network: network
    };
    // Create instance of BitskiProvider
    this.provider = Bitski.getProvider(clientId, options);
    this.provider.start();
    // Create instance of web3
    this.web3 = new Web3(this.provider);
    // Create instance of server
    this.app = Express();
  }

  /**
   * Starts the app by connecting to Ethereum network and starting the Express server
   * @param {number} port Port to start the server on
   */
  async start(port) {
    console.log('starting app...');
    try {
      // Get accounts
      const accounts = await this.web3.eth.getAccounts();
      // Check to make sure we have an account
      if (accounts.length == 0) {
        throw new Error('No account found');
      }

      // Set current account
      this.currentAccount = accounts[0];

      this.balance = await this.web3.eth.getBalance(this.currentAccount);

      // Set network id
      this.networkId = await this.web3.eth.net.getId();

      // Create instance of contract
      this.contract = await new Contract(this.web3, this.networkId, artifacts).deployed();

      // Cache token name
      this.name = await this.contract.methods.name().call();

      // Create the server
      this.createServer(port);

      // Refresh balance every 60 seconds
      this.updateBalance();

      // Watch for new events
      this.watchTransferEvents();
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  }

  /**
   * Watches for new Transfer events from this contract and logs them to the console
   */
  watchTransferEvents() {
    this.contract.events.Transfer().on('data', (event) => {
      const { to, from, tokenId } = event.returnValues;
      console.log(`Token ${tokenId} was transferred from ${from} to ${to}`);
    }).on('error', (error) => {
      console.log('Error subscribing', error);
    });
  }

  /**
   * We regularly check the balance of our App Wallet to make sure we're still funded.
   */
  updateBalance() {
    setTimeout(() => {
      this.web3.eth.getBalance(this.currentAccount).then(balance => {
        this.balance = balance;
        console.log(`Current balance: ${balance}`);
      }).catch(error => {
        console.error(error);
      });
      this.updateBalance();
    }, 60 * 1000);
  }

  /**
   * Starts the Express server and defines the route
   * @param {number} port The port to start the server on
   */
  createServer(port) {
    // Allow CORS
    this.app.use(cors());

    // Returns some metadata and health information. You could use this to consume the contract
    // address in your web app for example, or use a monitoring service to ensure sufficient balance.
    this.app.get('/', (req, res) => {
      res.send({
        networkId: this.networkId,
        contractAddress: this.contract.options.address,
        address: this.currentAccount,
        balance: this.balance,
        name: this.name
      });
    });

    // Returns the abi of the contract. You could potentially use this to send
    // your contract source to a web client and keep it in sync.
    this.app.get('/abi', (req, res) => {
      res.send(artifacts);
    });

    // Contract State

    // Returns the total supply (total number of tokens)
    this.app.get('/totalSupply', (req, res) => {
      this.contract.methods.totalSupply().call().then(totalSupply => {
        res.send(totalSupply);
      }).catch(error => {
        res.send(error);
      });
    });

    // Returns the name of the contract. Not really that useful :)
    this.app.get('/name', (req, res) => {
      this.contract.methods.name().call().then(name => {
        res.send({ name });
      }).catch(error => {
        res.send(error);
      });
    });

    // Returns the mint limit directly from the contract
    // (the arbitrary maximum number of tokens per address)
    this.app.get('/mintLimit', (req, res) => {
      this.contract.methods.mintLimit().call().then(mintLimit => {
        res.send({ mintLimit });
      }).catch(error => {
        res.send(error);
      });
    });

    // Returns the symbol of the contact (part of the ERC721 standard)
    this.app.get('/symbol', (req, res) => {
      this.contract.methods.symbol().call().then(symbol => {
        res.send({ symbol });
      }).catch(error => {
        res.send(error);
      });
    });

    // Returns all token ids that belong to the provided address.
    // You could use something like this to load data on your client
    // in a more standard JSON format, rather than dealing with web3.
    this.app.get('/:ownerAddress/tokens', (req, res) => {
      const owner = req.params.ownerAddress;
      this.contract.methods.balanceOf(owner).call().then(balance => {
        let promises = [];
        for (var i=0; i < balance; i++) {
          const promise = this.contract.methods.tokenOfOwnerByIndex(owner, i).call();
          promises.push(promise);
        }
        return Promise.all(promises).then(tokens => {
          res.send({ tokens });
        });
      }).catch(error => {
        res.send(error);
      });
    });

    // Returns the token balance of the provided address.
    this.app.get('/:ownerAddress/balance', (req, res) => {
      this.contract.methods.balanceOf(req.params.ownerAddress).call().then(balance => {
        res.send({ balance });
      }).catch(error => {
        res.send(error);
      });
    });

    // Token Metadata

    // An important part of NFTs is showing the characteristics of the token.
    // The ERC-721 spec includes a method for getting a web URI that includes the
    // details of the token in a JSON format. Our backend app can not only host that end-point
    // but load some of the metadata from the contract itself, completing the loop.
    this.app.get('/tokens/:tokenId', (req,res) => {
      if (!req.params.tokenId || !req.params.tokenId.match(/^\d+$/g)) {
        return res.send({ error: { message: 'Invalid token id passed' } });
      }
      // Load character index from the contract (used to determine which image asset to return)
      this.contract.methods.imageId(req.params.tokenId).call().then(imageIndex => {
        const baseUrl = process.env.WEB_URL || 'https://example-dapp-1.bitski.com';
        const description = 'An example of an ERC-721 token';
        const name = this.name; // this is loaded from the contract when we boot
        const imageUrl = `${baseUrl}/assets/character-${imageIndex}.png`;

        //The ERC-721 Metadata standard
        const erc721Details = {
          name: name,
          description: description,
          image: imageUrl
        };

        // Additional OpenSea Metadata
        const openSeaExtras = {
          external_url: baseUrl,
        };

        // Additional RareBits Metadata
        const rareBitsExtras = {
          image_url: imageUrl,
          home_url: baseUrl
        };

        res.send(Object.assign({}, erc721Details, openSeaExtras, rareBitsExtras));
      });
    });

    // Returns the tokenURI for a given token ID from the contract
    this.app.get('/tokenURI/:tokenId', (req, res) => {
      this.contract.methods.tokenURI(req.params.tokenId).call().then(uri => {
        res.send({ tokenURI: uri});
      }).catch(err => {
        res.send({ error: err.toString() });
      });
    });

    // Transactions with App Wallet

    // In this example, our tokens are free and anyone can request one. We use this
    // POST method to allow clients to request a token to be minted and sent to the
    // provided address. This way the end user doesn't have to pay for the transaction fee.
    //
    // You could easily modify this to accept fiat currency for NFTs by having this
    // be the result of a successful credit card or in-app purchase transaction,
    // and lock down the minting of tokens to only be possible via your App Wallet's address.
    this.app.post('/tokens/new', (req, res) => {
      // Extract the "to" from the request. You'll still need an address to send the token to.
      const to = req.query.to;

      // Create a random token id
      const tokenId = this.web3.utils.randomHex(32);
      const tokenIdString = this.web3.utils.hexToNumberString(tokenId);

      // Generate the token URI (points at this app)
      const baseUrl = process.env.API_URL || 'https://example-dapp-1-api.bitski.com';
      const tokenURI = `${baseUrl}/tokens/${tokenIdString}`;

      // Create the transaction with the inputs
      const method = this.contract.methods.mintWithTokenURI(to, tokenId, tokenURI);

      // Estimate the gas we need to submit the transaction
      method.estimateGas().then(gas => {
        try {
          // Submit the transaction. It will be signed automatically by App Wallet
          method.send({
            from: this.currentAccount,
            gas: gas,
            gasPrice: '1100000000' // Ideally this would be dynamically updated based on demand.
          }, (error, transactionHash) => {
            if (error) {
              console.error(error);
              res.send({ error: error.toString() });
            } else if (transactionHash) {
              // Return token hash (so that the transaction can be watched), and
              // the generated tokenId (so that the client can instantly update).
              res.send({ transactionHash, tokenId });
            } else {
              res.send({ error: 'The transaction hash could not be found.' });
            }
          });
        } catch (error) {
          console.error(error);
          res.send({ error: error.toString() });
        }
      }).catch(error => {
        res.send({ error: error.toString() });
      });
    });

    // Start server
    this.app.listen(port, () => console.log(`Listening on port ${port}!`));
  }
}

module.exports = App;
