function shouldUseSingleInstanceLock({ isPackaged, env = process.env } = {}) {
  return !!isPackaged || env.SWITCHBOARD_FORCE_SINGLE_INSTANCE === '1';
}

module.exports = { shouldUseSingleInstanceLock };
