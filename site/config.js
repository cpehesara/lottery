// Settings you may want to change after deploying.
window.APP_CONFIG = {
  // Where the fetched results live (the folder that contains index.json).
  //  - Recommended: your public GitHub repo, so new results appear without redeploying:
  //      'https://raw.githubusercontent.com/YOUR-NAME/YOUR-REPO/main/results/'
  //  - Or keep 'results/' if you copy the results folder into this site and redeploy.
  resultsBase: 'results/',

  // Optional: link shown when a date is missing, so you can start a fetch from your phone.
  //   'https://github.com/YOUR-NAME/YOUR-REPO/actions/workflows/fetch.yml'
  actionsUrl: '',

  // Standard print settings (used until a device saves its own choice).
  //  orientation: 'landscape' | 'portrait'      columns: 1-6 copies side by side
  //  textScale: 40-100 (100 = biggest that fits)  titleScale: 70-140   footerScale: 70-170
  //  nameScale / letterScale / numberScale: 50-200 (text inside the table; 100 = original look)
  //  layout: 'large' | 'stretch' | 'fit'
  printDefaults: {
    orientation: 'landscape',
    columns: 3,
    layout: 'large',
    textScale: 100,
    titleScale: 100,
    footerScale: 100,
    nameScale: 100,
    letterScale: 100,
    numberScale: 100
  }
};