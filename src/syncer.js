const {Configuration} = require('@schul-cloud/commons');
const matrix_admin_api = require('./matrixApi');

const MATRIX_SERVERNAME = Configuration.get('MATRIX_SERVERNAME');

module.exports = {
  syncUserWithMatrix,
  getOrCreateUser,
  createUser,
};


// PUBLIC FUNCTIONS
async function syncUserWithMatrix(payload) {
  const user_id = payload.user.id;
  await getOrCreateUser(payload.user);

  if (payload.rooms) {
    await asyncForEach(payload.rooms, async (room) => {
      const alias = `${room.type}_${room.id}`;
      const fq_alias = `%23${alias}:${MATRIX_SERVERNAME}`;
      const topic = room.description || (room.type === 'team' && 'Team') || (room.type === 'course' && 'Kurs');

      const room_matrix_id = await getOrCreateRoom(fq_alias, alias, room.name, payload.school.name, topic);
      await joinUserToRoom(user_id, room_matrix_id);

      // check if exists and permissions levels are what we want
      let desiredUserPower = 50;
      if (room.bidirectional === true) {
        desiredUserPower = 0;
      }

      // this can run async
      await Promise.all([
        setRoomEventsDefault(room_matrix_id, desiredUserPower),
        setModerator(room_matrix_id, payload.user.id, room.is_moderator),
      ]);
    });
  }

  // always join user (previous check can be implemented later)
  if (payload.school.has_allhands_channel) {
    const room_name = 'Ankündigungen';
    const topic = `${payload.school.name}`;
    const alias = `news_${payload.school.id}`;
    const fq_alias = `%23${alias}:${MATRIX_SERVERNAME}`;

    const room_matrix_id = await getOrCreateRoom(fq_alias, alias, room_name, payload.school.name, topic);
    const current_permission = payload.user.is_school_admin ? await getUserRoomLevel(room_matrix_id, payload.user.id) : null;
    await setRoomEventsDefault(room_matrix_id, 50);
    await joinUserToRoom(user_id, room_matrix_id);

    if (payload.user.is_school_admin && current_permission !== 50) {
      await setModerator(room_matrix_id, payload.user.id, true);
    }
  } else {
    // TODO: delete or block room if setting is changed
  }

  // Lehrerzimmer
  if (payload.user.is_school_teacher === true) {
    const room_name = 'Lehrerzimmer';
    const topic = `${payload.school.name}`;
    const alias = `teachers_${payload.school.id}`;
    const fq_alias = `%23${alias}:${MATRIX_SERVERNAME}`;

    const room_matrix_id = await getOrCreateRoom(fq_alias, alias, room_name, payload.school.name, topic);
    const current_permission = null;
    // setRoomEventsDefault(room_matrix_id, 50);
    await joinUserToRoom(user_id, room_matrix_id);

    if (payload.user.is_school_admin && current_permission !== 50) {
      await setModerator(room_matrix_id, payload.user.id, true);
    }
  }
}

// INTERNAL FUNCTIONS
async function getOrCreateUser(user) {
  // check if user exists
  // Docu: https://github.com/matrix-org/synapse/blob/master/docs/admin_api/user_admin_api.rst#query-account
  await matrix_admin_api
    .get(`/_synapse/admin/v2/users/${user.id}`)
    .then(() => {
      console.log(`user ${user.id} found.`);
    })
    .catch(() => {
      console.log(`user ${user.id} not there yet.`);
      return createUser(user);
    });
}

async function createUser(user) {
  // Docu: https://github.com/matrix-org/synapse/blob/master/docs/admin_api/user_admin_api.rst#create-or-modify-account
  const newUser = {
    password: Math.random().toString(36), // we will never use this, password login should be disabled
    displayname: user.name,
    threepids: [],
    admin: false,
    deactivated: false,
  };
  if (user.email) {
    newUser.threepids.push({
      medium: 'email',
      address: user.email,
    });
  }

  return matrix_admin_api
    .put(`/_synapse/admin/v2/users/${user.id}`, newUser)
    .then(() => {
      console.log(`user ${user.id} created.`);
    })
    .catch(logRequestError);
}

async function setRoomEventsDefault(room_matrix_id, events_default) {
  const room_state = await getRoomState(room_matrix_id);
  if (room_state && room_state.events_default !== events_default) {
    room_state.events_default = events_default;
    await matrix_admin_api
      .put(`/_matrix/client/r0/rooms/${room_matrix_id}/state/m.room.power_levels`, room_state)
      .catch(logRequestError);
  }
}

async function joinUserToRoom(user_id, room_id) {
  // TODO: Check if the user is already in the room to avoid reseting the user state

  // Send invite
  await matrix_admin_api
    .post(`/_matrix/client/r0/rooms/${room_id}/invite`, {
      user_id,
    })
    .then((response) => {
      if (response.status === 200) {
        console.log(`user ${user_id} invited ${room_id}`);
      }
    })
    .catch(() => {
      // user may already be in the room
    });

  // Accept invite
  await matrix_admin_api
    .post(`/_synapse/admin/v1/join/${room_id}`, {
      user_id,
    })
    .then((response) => {
      if (response.status === 200) {
        console.log(`user ${user_id} joined ${room_id}`);
      }
    })
    .catch(logRequestError);
}

async function getOrCreateRoom(fq_alias, alias, room_name, school_name, topic = null) {
  // get room id
  return matrix_admin_api
    .get(`/_matrix/client/r0/directory/room/${fq_alias}`)
    .then((response) => {
      const {room_id} = response.data;
      console.log(`room ${room_id} found`);
      checkRoomName(room_id, room_name);
      return room_id;
    })
    .catch(async () => {
      console.log(`room ${fq_alias} not found`);
      return createRoom(alias, room_name, school_name, topic);
    });
}

async function checkRoomName(room_id, room_name) {
  return matrix_admin_api
    .get(`/_matrix/client/r0/rooms/${room_id}/state/m.room.name`)
    .then((response) => {
      if (response.data.name !== room_name) {
        return matrix_admin_api
          .put(`/_matrix/client/r0/rooms/${room_id}/state/m.room.name`, {name: room_name})
          .then(() => {
            console.log(`room name updated to ${room_name}`);
            return false;
          });
      }
      return true;
    });
}

async function createRoom(alias, room_name, school_name, topic) {
  return matrix_admin_api
    .post('/_matrix/client/r0/createRoom', {
      preset: 'private_chat', // this allows guest, we might want to disallow this later
      room_alias_name: alias,
      name: room_name,
      topic: topic || `Kanal für ${room_name} (${school_name})`,
      creation_content: {},
    })
    .then(async (response) => {
      const room_matrix_id = response.data.room_id;
      const tmp_state = await getRoomState(room_matrix_id);
      tmp_state.invite = 70;
      await setRoomState(room_matrix_id, tmp_state);
      return room_matrix_id;
    })
    .catch(logRequestError);
}

async function getUserRoomLevel(room_matrix_id, user_id) {
  return matrix_admin_api.get(`/_matrix/client/r0/rooms/${room_matrix_id}/state`)
    .then((response) => {
      if (response.status === 200) {
        if (response.data && response.data.users && response.data.users[user_id]) {
          return response.data.users[user_id];
        }
      }
      return null;
    })
    .catch(logRequestError);
}

async function getRoomState(room_matrix_id) {
  return matrix_admin_api
    .get(`/_matrix/client/r0/rooms/${room_matrix_id}/state/m.room.power_levels`)
    .then((response) => response.data)
    .catch(logRequestError);
}

async function setRoomState(room_matrix_id, room_state) {
  return matrix_admin_api
    .put(`/_matrix/client/r0/rooms/${room_matrix_id}/state/m.room.power_levels`, room_state)
    .then(() => {
      console.log(`set roomm state in ${room_matrix_id}`);
      return true;
    })
    .catch(logRequestError);
}

async function setModerator(room_matrix_id, user_id, is_moderator) {
  // check moderator
  const room_state = await getRoomState(room_matrix_id);
  if (is_moderator && room_state && room_state.users) {
    if (!(room_state.users[user_id] && room_state.users[user_id] === 50)) {
      room_state.users[user_id] = 50;
      await setRoomState(room_matrix_id, room_state);
    } else {
      console.log('user is already a moderator');
    }
    // TODO: Delete moderator if value is false
  } else if (room_state && room_state.user && room_state.users[user_id] && room_state.users[user_id] === 50) {
    delete room_state.users[user_id];
    await matrix_admin_api
      .put(`/_matrix/client/r0/rooms/${room_matrix_id}/state/m.room.power_levels`, room_state)
      .then((response) => {
        console.log(response.data);
      })
      .catch(logRequestError);
  }
}

async function asyncForEach(array, callback) {
  const promises = [];
  for (let index = 0; index < array.length; index += 1) {
    promises.push(callback(array[index], index, array));
  }
  return Promise.all(promises);
}

// HELPER FUNCTIONS
function logRequestError(error) {
  if (error.response) {
    /*
     * The request was made and the server responded with a
     * status code that falls out of the range of 2xx
     */
    console.error(error.response.status, error.response.data, error.response.headers);
  } else if (error.request) {
    /*
     * The request was made but no response was received, `error.request`
     * is an instance of XMLHttpRequest in the browser and an instance
     * of http.ClientRequest in Node.js
     */
    console.error(error.request);
  } else {
    // Something happened in setting up the request and triggered an Error
    console.error('Error', error.message);
  }

  console.log('for request', error.config);
  throw error;
}
