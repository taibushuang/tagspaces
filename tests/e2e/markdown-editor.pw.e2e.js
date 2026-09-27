/*
 * Copyright (c) 2016-present - TagSpaces GmbH. All rights reserved.
 */
import fs from 'fs';
import pathLib from 'path';
import { test, expect } from './fixtures';
import {
  defaultLocationName,
  createPwLocation,
  createS3Location,
} from './location.helpers';
import {
  clickOn,
  expectElementExist,
  expectFileContain,
  frameLocator,
  getGridFileSelector,
  isDisplayed,
  takeScreenshot,
  writeTextInIframeInput,
} from './general.helpers';
import { startTestingApp, stopApp } from './hook';
import { openContextEntryMenu, toContainTID } from './test-utils';
import { clearDataStorage, closeWelcomePlaywright } from './welcome.helpers';
import { dataTidFormat } from '../../src/renderer/services/test';

test.beforeAll(async ({ isWeb, isS3, webServerPort }, testInfo) => {
  await startTestingApp({ isWeb, isS3, webServerPort, testInfo });
  // await clearDataStorage();
});

test.afterAll(async () => {
  await stopApp();
});

test.afterEach(async ({ page }, testInfo) => {
  /*if (testInfo.status !== testInfo.expectedStatus) {
    await takeScreenshot(testInfo);
  }*/
  await clearDataStorage();
});

test.beforeEach(async ({ isS3, testDataDir }) => {
  await closeWelcomePlaywright();
  if (isS3) {
    await createS3Location('', defaultLocationName, true);
  } else {
    await createPwLocation(testDataDir, defaultLocationName, true);
  }
  await clickOn('[data-tid=location_' + defaultLocationName + ']');
  await expectElementExist(getGridFileSelector('empty_folder'), true, 15000);
  // If its have opened file
  // await closeFileProperties();
});

test.describe('TST69 - Markdown editor', () => {
  test('TST6901 - Open and render md file [web,s3,electron]', async () => {
    await openContextEntryMenu(
      getGridFileSelector('sample.md'),
      'fileMenuOpenFile',
    );
    await expect
      .poll(
        async () => {
          const fLocator = await frameLocator();
          const bodyTxt = await fLocator.locator('body').innerText();
          return toContainTID(bodyTxt);
        },
        {
          message: 'make sure bodyTxt contain etete&5435', // custom error message
          // Poll for 10 seconds; defaults to 5 seconds. Pass 0 to disable timeout.
          timeout: 10000,
        },
      )
      .toBe(true);
  });

  test('TST6902 - Open settings [web,s3,electron]', async () => {
    await openContextEntryMenu(
      getGridFileSelector('sample.md'),
      'fileMenuOpenFile',
    );
    await clickOn('[data-tid=fileContainerEditFile]');
    // Access the iframe
    const iframeElement = await global.client.waitForSelector('iframe');
    const frame = await iframeElement.contentFrame();

    await frame.click('[data-tid=mainMenuTID]');
    await frame.click('[data-tid=settingsIDTID]');

    let settingsExists = await isDisplayed(
      '#md-editor-settings-title',
      true,
      2000,
      frame,
    );
    expect(settingsExists).toBeTruthy();

    await frame.click('[data-tid=settingsOkTID]');

    settingsExists = await isDisplayed(
      '#md-editor-settings-title',
      false,
      2000,
      frame,
    );
    expect(settingsExists).toBeTruthy();
  });

  test('TST6903 - Save text [web,s3,electron]', async () => {
    // open fileProperties
    const fileName = 'sample.md';
    const newFileContent = 'etete&5435_new_text_saved';
    await clickOn(getGridFileSelector(fileName));
    await expectElementExist(
      '[data-tid=OpenedTID' + dataTidFormat(fileName) + ']',
      true,
      8000,
    );
    await clickOn('[data-tid=fileContainerEditFile]');
    await writeTextInIframeInput(
      newFileContent,
      '.milkdown div[contenteditable=true]',
    );
    await clickOn('[data-tid=fileContainerSaveFile]');
    // Wait for S3 write to complete before reloading
    await global.client.waitForTimeout(1500);
    await clickOn('[data-tid=cancelEditingTID]');
    await clickOn('[data-tid=propsActionsMenuTID]');
    await clickOn('[data-tid=reloadPropertiesTID]');
    await expectFileContain(newFileContent, 15000);
  });

  test('TST6904 - View mode: double click does not enter edit mode, edit button does [electron]', async () => {
    const fileName = 'sample.md';
    await openContextEntryMenu(
      getGridFileSelector(fileName),
      'fileMenuOpenFile',
    );
    await expectElementExist(
      '[data-tid=OpenedTID' + dataTidFormat(fileName) + ']',
      true,
      8000,
    );
    // Wait until the viewer iframe has rendered the milkdown content
    await expect
      .poll(
        async () => {
          const fLocator = await frameLocator();
          return await fLocator.locator('.milkdown').count();
        },
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);

    const iframeElement = await global.client.waitForSelector('iframe');
    const frame = await iframeElement.contentFrame();
    // Double click anywhere in the document body — must NOT switch to edit mode
    await frame.dblclick('body');
    await global.client.waitForTimeout(1500);

    // Still in view mode: edit button visible, no editable content
    await expectElementExist('[data-tid=fileContainerEditFile]', true, 5000);
    const editable = await frame.$('.milkdown div[contenteditable=true]');
    expect(editable).toBeNull();

    // The edit button enters edit mode
    await clickOn('[data-tid=fileContainerEditFile]');
    await expect
      .poll(
        async () => {
          const fLocator = await frameLocator();
          return await fLocator
            .locator('.milkdown div[contenteditable=true]')
            .count();
        },
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
  });

  test('TST6905 - Reload opened md file via toolbar button picks up external changes [electron]', async ({
    testDataDir,
  }) => {
    const fileName = 'sample.md';
    await openContextEntryMenu(
      getGridFileSelector(fileName),
      'fileMenuOpenFile',
    );
    await expectElementExist(
      '[data-tid=OpenedTID' + dataTidFormat(fileName) + ']',
      true,
      8000,
    );

    // Simulate an external program changing the file on disk
    const reloadMarker = 'reloadMarker' + Date.now();
    const filePath = pathLib.join(testDataDir, fileName);
    fs.writeFileSync(
      filePath,
      fs.readFileSync(filePath, 'utf8') + '\n\n' + reloadMarker + '\n',
    );

    // Toolbar reload button refreshes the opened file from disk
    await clickOn('[data-tid=fileContainerReloadFile]');
    await expectFileContain(reloadMarker, 15000);
  });
});
