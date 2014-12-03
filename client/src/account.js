/* Crypton Client, Copyright 2013 SpiderOak, Inc.
 *
 * This file is part of Crypton Client.
 *
 * Crypton Client is free software: you can redistribute it and/or modify it
 * under the terms of the Affero GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version.
 *
 * Crypton Client is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the Affero GNU General Public
 * License for more details.
 *
 * You should have received a copy of the Affero GNU General Public License
 * along with Crypton Client.  If not, see <http://www.gnu.org/licenses/>.
*/

(function() {

'use strict';

/**!
 * # Account()
 *
 * ````
 * var account = new crypton.Account();
 * ````
 */
var Account = crypton.Account = function Account () {};

/**!
 * ### save(callback)
 * Send the current account to the server to be saved
 *
 * Calls back without error if successful
 *
 * Calls back with error if unsuccessful
 *
 * @param {Function} callback
 */
Account.prototype.save = function (callback) {
  superagent.post(crypton.url() + '/account')
    .withCredentials()
    .send(this.serialize())
    .end(function (res) {
      if (res.body.success !== true) {
        callback(res.body.error);
      } else {
        callback();
      }
    }
  );
};

/**!
 * ### unravel(callback)
 * Decrypt raw account object from server after successful authentication
 *
 * Calls back without error if successful
 *
 * __Throws__ if unsuccessful
 *
 * @param {Function} callback
 */
Account.prototype.unravel = function (callback) {
  var that = this;
  console.log('\n\nAccount.unravel\n\n');
  // console.log(this.serialize());
  crypton.work.unravelAccount(this, function (err, data) {
    if (err) {
      console.log(err);
      return callback(err);
    }

    that.regenerateKeys(data, function (err) {
      callback(err);
    });
  });
};

/**!
 * ### regenerateKeys(callback)
 * Reconstruct keys from unraveled data
 *
 * Calls back without error if successful
 *
 * __Throws__ if unsuccessful
 *
 * @param {Function} callback
 */
Account.prototype.regenerateKeys = function (data, callback) {
  // reconstruct secret key
  var exponent = sjcl.bn.fromBits(data.secret.exponent);
  this.secretKey = new sjcl.ecc.elGamal.secretKey(data.secret.curve, sjcl.ecc.curves['c' + data.secret.curve], exponent);

  // reconstruct public key
  var point = sjcl.ecc.curves['c' + this.pubKey.curve].fromBits(this.pubKey.point);
  this.pubKey = new sjcl.ecc.elGamal.publicKey(this.pubKey.curve, point.curve, point);

  // assign the hmac keys to the account
  this.hmacKey = data.hmacKey;
  this.containerNameHmacKey = data.containerNameHmacKey;

  // reconstruct the public signing key
  var signPoint = sjcl.ecc.curves['c' + this.signKeyPub.curve].fromBits(this.signKeyPub.point);
  this.signKeyPub = new sjcl.ecc.ecdsa.publicKey(this.signKeyPub.curve, signPoint.curve, signPoint);

  // reconstruct the secret signing key
  var signExponent = sjcl.bn.fromBits(data.signKeySecret.exponent);
  this.signKeyPrivate = new sjcl.ecc.ecdsa.secretKey(data.signKeySecret.curve, sjcl.ecc.curves['c' + data.signKeySecret.curve], signExponent);

  // calculate fingerprint for public key
  this.fingerprint = crypton.fingerprint(this.pubKey, this.signKeyPub);

  // recalculate the public points from secret exponents
  // and verify that they match what the server sent us
  var pubKeyHex = sjcl.codec.hex.fromBits(this.pubKey._point.toBits());
  var pubKeyShouldBe = this.secretKey._curve.G.mult(exponent);
  var pubKeyShouldBeHex = sjcl.codec.hex.fromBits(pubKeyShouldBe.toBits());

  if (!crypton.constEqual(pubKeyHex, pubKeyShouldBeHex)) {
    return callback('Server provided incorrect public key');
  }

  var signKeyPubHex = sjcl.codec.hex.fromBits(this.signKeyPub._point.toBits());
  var signKeyPubShouldBe = this.signKeyPrivate._curve.G.mult(signExponent);
  var signKeyPubShouldBeHex = sjcl.codec.hex.fromBits(signKeyPubShouldBe.toBits());

  if (!crypton.constEqual(signKeyPubHex, signKeyPubShouldBeHex)) {
    return callback('Server provided incorrect public signing key');
  }

  // sometimes the account object is used as a peer
  // to make the code simpler. verifyAndDecrypt checks
  // that the peer it is passed is trusted, or returns
  // an error. if we've gotten this far, we can be sure
  // that the public keys are trustable.
  this.trusted = true;

  callback(null);
};

/**!
 * ### serialize()
 * Package and return a JSON representation of the current account
 *
 * @return {Object}
 */
// TODO rename to toJSON
Account.prototype.serialize = function () {
  return {
    srpVerifier: this.srpVerifier,
    srpSalt: this.srpSalt,
    containerNameHmacKeyCiphertext: this.containerNameHmacKeyCiphertext,
    hmacKeyCiphertext: this.hmacKeyCiphertext,
    keypairCiphertext: this.keypairCiphertext,
    keypairMac: this.keypairMac,
    pubKey: this.pubKey,
    keypairSalt: this.keypairSalt,
    keypairMacSalt: this.keypairMacSalt,
    signKeyPrivateMacSalt: this.signKeyPrivateMacSalt,
    username: this.username,
    signKeyPub: this.signKeyPub,
    signKeyPrivateCiphertext: this.signKeyPrivateCiphertext,
    signKeyPrivateMac: this.signKeyPrivateMac
  };
};

/**!
 * ### verifyAndDecrypt()
 * Convienence function to verify and decrypt public key encrypted & signed data
 *
 * @return {Object}
 */
Account.prototype.verifyAndDecrypt = function (signedCiphertext, peer) {
  if (!peer.trusted) {
    return {
      error: 'Peer is untrusted'
    }
  }

  // hash the ciphertext
  var ciphertextString = JSON.stringify(signedCiphertext.ciphertext);
  var hash = sjcl.hash.sha256.hash(ciphertextString);
  // verify the signature
  var verified = false;
  try {
    verified = peer.signKeyPub.verify(hash, signedCiphertext.signature);
  } catch (ex) { }
  // try to decrypt regardless of verification failure
  try {
    var message = sjcl.decrypt(this.secretKey, ciphertextString, crypton.cipherOptions);
    if (verified) {
      return { plaintext: message, verified: verified, error: null };
    } else {
      return { plaintext: null, verified: false, error: 'Cannot verify ciphertext' };
    }
  } catch (ex) {
    return { plaintext: null, verified: false, error: 'Cannot verify ciphertext' };
  }
};

/**!
 * ### changePassphrase()
 * Convienence function to change the user's passphrase
 *
 * @param {String} currentPassphrase
 * @param {String} newPassphrase
 * @param {Function} callback
 * @param {Function} keygenProgressCallback [optional]
 * @param {Boolean} skipCheck [optional]
 * @return void
 */
Account.prototype.changePassphrase =
  function (currentPassphrase, newPassphrase,
            callback, keygenProgressCallback, skipCheck) {
  console.log('Change Passphrase...');
  console.log('old pass: ', currentPassphrase);
  console.log('new pass: ', newPassphrase);
  console.log('cb: ', callback);
  console.log('cb2: ', keygenProgressCallback);
  console.log('skipCheck: ', skipCheck);
  if (skipCheck) {
    if (currentPassphrase == newPassphrase) {
      var err = 'New passphrase cannot be the same as current password';
      return callback(err);
    }
  }

  if (keygenProgressCallback) {
    if (typeof keygenProgressCallback == 'function') {
      keygenProgressCallback();
    }
  }

  var MIN_PBKDF2_ROUNDS = crypton.MIN_PBKDF2_ROUNDS;
  var that = this;
  var username = this.username;
  // authorize to make sure the user knows the correct passphrase
  crypton.authorize(username, currentPassphrase, function (err, newSession) {
    if (err) {
      console.error(err);
      return callback(err);
    }
    // We have authorized, time to create the new keyring parts we
    // need to update the database

    var currentAccount = newSession.account;

    // Replace all salts with new ones
    var keypairSalt = crypton.randomBytes(32);
    var keypairMacSalt = crypton.randomBytes(32);
    var signKeyPrivateMacSalt = crypton.randomBytes(32);

    var srp = new SRPClient(username, newPassphrase, 2048, 'sha-256');
    var srpSalt = srp.randomHexSalt();
    var srpVerifier = srp.calculateV(srpSalt).toString(16);

    var keypairKey =
      sjcl.misc.pbkdf2(newPassphrase, keypairSalt, MIN_PBKDF2_ROUNDS);

    var keypairMacKey =
      sjcl.misc.pbkdf2(newPassphrase, keypairMacSalt, MIN_PBKDF2_ROUNDS);

    var signKeyPrivateMacKey =
      sjcl.misc.pbkdf2(newPassphrase, signKeyPrivateMacSalt, MIN_PBKDF2_ROUNDS);

    var newKeyring = {};
    // Re-encrypt the stored keyring
    // XXXddahl:
    //         Change all of these sjcl.encrypt() to selfPeer.encryptAndSign()
    var selfPeer = new crypton.Peer({
      session: newSession,
      pubKey: JSON.stringify(newSession.account.pubKey.serialize()),
      trusted: true
    });
    // ...
    newKeyring.containerNameHmacKeyCiphertext =
      sjcl.encrypt(keypairKey,
                   JSON.stringify(currentAccount.containerNameHmacKey),
                   crypton.cipherOptions);

    newKeyring.hmacKeyCiphertext =
      sjcl.encrypt(keypairKey,
                   JSON.stringify(currentAccount.hmacKey),
                   crypton.cipherOptions);

    newKeyring.signKeyPrivateCiphertext =
      sjcl.encrypt(keypairKey,
                   JSON.stringify(currentAccount.signKeyPrivate.serialize()),
                   crypton.cipherOptions);

    newKeyring.keypairCiphertext =
      sjcl.encrypt(keypairKey,
                   JSON.stringify(currentAccount.secretKey.serialize()),
                   crypton.cipherOptions);

    newKeyring.keypairMac =
      crypton.hmac(keypairMacKey, newKeyring.keypairCiphertext);

    newKeyring.signKeyPrivateMac = crypton.hmac(signKeyPrivateMacKey,
                                                newKeyring.signKeyPrivateCiphertext);

    // Set the new properties before we save
    newKeyring.keypairSalt = JSON.stringify(keypairSalt);
    newKeyring.keypairMacSalt = JSON.stringify(keypairMacSalt);
    newKeyring.signKeyPrivateMacSalt = JSON.stringify(signKeyPrivateMacSalt);
    newKeyring.srpVerifier = srpVerifier;
    newKeyring.srpSalt = srpSalt;

    console.log('SAVING..............');
    // POST to /account/:username/keyring
    superagent.post(crypton.url() + '/account/' + that.username + '/keyring')
    .withCredentials()
    .send(newKeyring)
    .end(function (res) {
      if (res.body.success !== true) {
        console.error('error: ', res.body.error);
        callback(res.body.error);
      } else {
        console.log('NO ERROR, password changed and shit');
        callback(null, newSession);
        // XXXddahl: force new login here
      }
    });

  }, null);
};

})();
