const fs = require('fs');

const {Configuration} = require('@hpi-schul-cloud/commons');
const syncer = require('../../src/syncer');
const authToken = require('../../src/authToken');

async function executeRandomizedTests(amount_users = 10, amount_rooms = 5, rooms_per_users = 5, export_users = false) {
  const school = {
    id: randomString(20),
    has_allhands_channel: true,
    name: 'Random School',
  };

  const users = [];
  const servername = Configuration.get('MATRIX_MESSENGER__SERVERNAME');
  for (let i = 0; i < amount_users; i += 1) {
    users.push({
      id: `@test_${randomString(10)}:${servername}`,
      name: 'Random Test User',
      email: `${randomString(10)}@test.com`,
      is_school_admin: false,
      is_school_teacher: false,
    });
  }

  const rooms = [];
  for (let i = 0; i < amount_rooms; i += 1) {
    rooms.push({
      id: `${randomString(10)}`,
      name: 'Random Room',
      type: 'course',
      bidirectional: true,
      is_moderator: false,
    });
  }

  // eslint-disable-next-line  no-restricted-syntax
  for (const user of users) {
    const msg = {
      school,
      user,
      rooms: [],
    };

    while (msg.rooms.length < rooms_per_users) {
      const roomIndex = Math.floor(Math.random() * rooms.length);
      const room = rooms[roomIndex];
      if (msg.rooms.filter((r) => r.id === room.id).length === 0) {
        room.is_moderator = user.is_school_teacher;
        msg.rooms.push(room);
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await syncer.syncUserWithMatrix(msg).catch(console.error);
  }

  // get users with tokens
  if (export_users) {
    await getUserTokens(users);
  }
}

function randomString(length) {
  const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const charactersLength = characters.length;

  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }

  return result;
}

async function getUserTokens(users) {
  // get users with tokens
  const result = [];

  // eslint-disable-next-line  no-restricted-syntax
  for (const user of users) {
    // eslint-disable-next-line no-await-in-loop
    await authToken.getUserToken(user.id)
      .then((token) => {
        result.push(token);
      })
      .catch(console.log);
  }

  fs.writeFileSync('users.json', JSON.stringify(result));
  return result;
}

const start = new Date();
executeRandomizedTests(10, 10, 5)
  .then(() => {
    const end = new Date() - start;
    console.log('Execution time: %dms', end);
  });
