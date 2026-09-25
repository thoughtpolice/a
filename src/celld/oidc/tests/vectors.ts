// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The examples of OpenID Connect Core 1.0 appendix A, signed RS256 with
 * the key of appendix A.7, issued 2011-07-21 (`iat` 1311280970, `exp`
 * 1311281970).
 *
 * @module
 */

import type { Jwk } from "@celld/jwt";

/** Appendix A.2: an ID token with profile claims. */
export const A2_ID_TOKEN =
  "eyJraWQiOiIxZTlnZGs3IiwiYWxnIjoiUlMyNTYifQ.ewogImlzcyI6ICJodHRwc" +
  "zovL3NlcnZlci5leGFtcGxlLmNvbSIsCiAic3ViIjogIjI0ODI4OTc2MTAwMSIsC" +
  "iAiYXVkIjogInM2QmhkUmtxdDMiLAogIm5vbmNlIjogIm4tMFM2X1d6QTJNaiIsC" +
  "iAiZXhwIjogMTMxMTI4MTk3MCwKICJpYXQiOiAxMzExMjgwOTcwLAogIm5hbWUiO" +
  "iAiSmFuZSBEb2UiLAogImdpdmVuX25hbWUiOiAiSmFuZSIsCiAiZmFtaWx5X25hb" +
  "WUiOiAiRG9lIiwKICJnZW5kZXIiOiAiZmVtYWxlIiwKICJiaXJ0aGRhdGUiOiAiM" +
  "DAwMC0xMC0zMSIsCiAiZW1haWwiOiAiamFuZWRvZUBleGFtcGxlLmNvbSIsCiAic" +
  "GljdHVyZSI6ICJodHRwOi8vZXhhbXBsZS5jb20vamFuZWRvZS9tZS5qcGciCn0.N" +
  "TibBYW_ZoNHGm4ZrWCqYA9oJaxr1AVrJCze6FEcac4t_EOQiJFbD2nVEPkUXPuMs" +
  "hKjjTn7ESLIFUnfHq8UKTGibIC8uqrBgQAcUQFMeWeg-PkLvDTHk43Dn4_aNrxhm" +
  "WwMNQfkjqx3wd2Fvta9j8yG2Qn790Gwb5psGcmBhqMJUUnFrGpyxQDhFIzzodmPo" +
  "kM7tnUxBNj-JuES_4CE-BvZICH4jKLp0TMu-WQsVst0ss-vY2RPdU1MzL59mq_eK" +
  "k8Rv9XhxIr3WteA2ZlrgVyT0cwH3hlCnRUsLfHtIEb8k1Y_WaqKUu3DaKPxqRi6u" +
  "0rN7RO2uZYPzC454xe-mg";

/** Appendix A.3: an ID token with `at_hash` of {@link A3_ACCESS_TOKEN}. */
export const A3_ID_TOKEN =
  "eyJraWQiOiIxZTlnZGs3IiwiYWxnIjoiUlMyNTYifQ.ewogImlzcyI6ICJodHRwc" +
  "zovL3NlcnZlci5leGFtcGxlLmNvbSIsCiAic3ViIjogIjI0ODI4OTc2MTAwMSIsC" +
  "iAiYXVkIjogInM2QmhkUmtxdDMiLAogIm5vbmNlIjogIm4tMFM2X1d6QTJNaiIsC" +
  "iAiZXhwIjogMTMxMTI4MTk3MCwKICJpYXQiOiAxMzExMjgwOTcwLAogImF0X2hhc" +
  "2giOiAiNzdRbVVQdGpQZnpXdEYyQW5wSzlSUSIKfQ.kdqTmftlaXg5WBYBr1wkxh" +
  "kqCGZPc0k8vTiV5g2jj67jQ7XkrDamYx2bOkZLdZrpMPIzkdYB1nZI_G8vQGQuam" +
  "RhJcEIt21kblGPZ-yhEhdkAiZIZLu38rChalDS2Mh0glE_rke5XXRhmqqoEFFdzi" +
  "FdnO3p61-7y51co84OEAZvARSINQaOWIzvioRfs4zwIFOaT33Vpxfqr8HDyh31zo" +
  "9eBW2dSQuCa071z0ENWChWoPliK1JCo_Bk9eDg2uwo2ZwhsvHzj6TMQ0lYOTzufS" +
  "lSmXIKfjlOsb3nftQeR697_hA-nMZyAdL8_NRfaC37XnAbW8WB9wCfECp7cuNuOg";

/** Appendix A.4: an ID token with `c_hash` of {@link A4_CODE}. */
export const A4_ID_TOKEN =
  "eyJraWQiOiIxZTlnZGs3IiwiYWxnIjoiUlMyNTYifQ.ewogImlzcyI6ICJodHRwc" +
  "zovL3NlcnZlci5leGFtcGxlLmNvbSIsCiAic3ViIjogIjI0ODI4OTc2MTAwMSIsC" +
  "iAiYXVkIjogInM2QmhkUmtxdDMiLAogIm5vbmNlIjogIm4tMFM2X1d6QTJNaiIsC" +
  "iAiZXhwIjogMTMxMTI4MTk3MCwKICJpYXQiOiAxMzExMjgwOTcwLAogImNfaGFza" +
  "CI6ICJMRGt0S2RvUWFrM1BrMGNuWHhDbHRBIgp9.MRPihYtNIcwKTZ_mcMSPfreV" +
  "ytGR4jfl1Tzbv4tH5Jr4WqONs2lUWrIEpZ2joKbZfAGlouAqwqSYpfR3FQYKYvdg" +
  "nZ3kjIJ_5M4fAARXHVSciGyhfqB-OhDUMXSHzFHiGKNY9TKSgRfiXf_314WRujpq" +
  "aDtj2uoXbppobYXvAZIxWtsOein0-t91LDS39EW4frNWAopKTBBi_XJPlpLVynWT" +
  "DvNleEBP6UxIMgYJBKlqsP7RGfHTGk3ReXDacR7RGZlIVGa-0qRyDzvNqD7xfu9a" +
  "YufUP0oBGqdBGgFVNmwJ7rmB0gdPtC2eJsXq9svCgBBfhRQZxhx1iLJjNc9nSw";

/** Appendix A.3's access token. */
export const A3_ACCESS_TOKEN = "jHkWEdUXMU1BwAsC4vtUsZwnNvTIxEl0z9K3vx5KF0Y";

/** Appendix A.4's code. */
export const A4_CODE =
  "Qcb0Orv1zh30vL1MPRsbm-diHiMwcLyZvn1arpZv-Jxf_11jnpEX3Tgfvk";

/** The issuer, client and nonce of every example. */
export const EXAMPLE = {
  issuer: "https://server.example.com",
  clientId: "s6BhdRkqt3",
  nonce: "n-0S6_WzA2Mj",
  subject: "248289761001",
  /** Epoch milliseconds between `iat` and `exp`. */
  at: 1311281000 * 1000,
} as const;

/** Appendix A.7: the RSA key the examples verify with. */
export const A7_KEY: Jwk = {
  kty: "RSA",
  kid: "1e9gdk7",
  n: "w7Zdfmece8iaB0kiTY8pCtiBtzbptJmP28nSWwtdjRu0f2GFpajvWE4VhfJAjEsO" +
    "cwYzay7XGN0b-X84BfC8hmCTOj2b2eHT7NsZegFPKRUQzJ9wW8ipn_aDJWMGDuB1" +
    "XyqT1E7DYqjUCEOD1b4FLpy_xPn6oV_TYOfQ9fZdbE5HGxJUzekuGcOKqOQ8M7wf" +
    "YHhHHLxGpQVgL0apWuP2gDDOdTtpuld4D2LK1MZK99s9gaSjRHE8JDb1Z4IGhEcE" +
    "yzkxswVdPndUWzfvWBBWXWxtSUvQGBRkuy1BHOa4sP6FKjWEeeF7gm7UMs2Nm2QU" +
    "gNZw6xvEDGaLk4KASdIxRQ",
  e: "AQAB",
};
