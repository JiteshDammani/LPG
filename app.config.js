module.exports = ({ config }) => {
  return {
    ...config,
    expo: {
      ...config.expo,
      android: {
        ...config.expo.android,
        googleServicesFile: process.env.GOOGLE_SERVICES_JSON || "./google-services.json",
      },
    },
  };
};
