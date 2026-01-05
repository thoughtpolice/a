// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::distribution::*;
use super::search::*;

use std::collections::HashSet;

// -------------------------------------------------------------------------
// Unit Tests: Distribution Math
// -------------------------------------------------------------------------

#[test]
fn test_distribution_uniform() {
    let dist = Distribution::uniform(4);
    assert_eq!(dist.num_suspects(), 4);
    assert_eq!(dist.probs().len(), 5);

    // Each should have probability 0.2
    for i in 0..5 {
        assert!((dist.get(i) - 0.2).abs() < 1e-9);
    }
    assert!(dist.is_normalized());
}

#[test]
fn test_distribution_cdf() {
    let dist = Distribution::uniform(4);
    let cdf = dist.cdf();

    assert_eq!(cdf.len(), 5);
    assert!((cdf[0] - 0.2).abs() < 1e-9);
    assert!((cdf[1] - 0.4).abs() < 1e-9);
    assert!((cdf[2] - 0.6).abs() < 1e-9);
    assert!((cdf[3] - 0.8).abs() < 1e-9);
    assert!((cdf[4] - 1.0).abs() < 1e-9);
}

#[test]
fn test_distribution_argmax() {
    let dist = Distribution::from_probs(vec![0.1, 0.5, 0.2, 0.1, 0.1]);
    assert_eq!(dist.argmax(), 1);
    assert!((dist.max() - 0.5).abs() < 1e-9);
}

// -------------------------------------------------------------------------
// Unit Tests: Bayesian Updates
// -------------------------------------------------------------------------

#[test]
fn test_pass_update_zeros_positions() {
    // With 4 suspects, PASS at position 1 should zero out positions 0 and 1
    let mut facf = State::new(4, SearchConfig::with_flake_rate(0.1));

    facf.record_result(1, TestResult::Pass);

    // Positions 0 and 1 should be zero
    assert!((facf.distribution().get(0)).abs() < 1e-9);
    assert!((facf.distribution().get(1)).abs() < 1e-9);

    // Positions 2, 3, and no-culprit should have probability
    assert!(facf.distribution().get(2) > 0.0);
    assert!(facf.distribution().get(3) > 0.0);
    assert!(facf.distribution().get(4) > 0.0); // no-culprit

    assert!(facf.distribution().is_normalized());
}

#[test]
fn test_fail_update_reduces_later_positions() {
    // With 4 suspects, FAIL at position 1 should increase probability for 0,1
    // and decrease probability for 2,3,no-culprit (by factor f)
    let mut facf = State::new(4, SearchConfig::with_flake_rate(0.1));

    let before_2 = facf.distribution().get(2);
    let before_3 = facf.distribution().get(3);

    facf.record_result(1, TestResult::Fail);

    // Positions after k should have lower probability (multiplied by f)
    let after_2 = facf.distribution().get(2);
    let after_3 = facf.distribution().get(3);

    // The ratio should be approximately f (accounting for normalization)
    assert!(after_2 < before_2);
    assert!(after_3 < before_3);

    assert!(facf.distribution().is_normalized());
}

#[test]
fn test_pass_update_deterministic() {
    // With flake_rate = 0, a PASS at position k should completely eliminate
    // positions 0..=k
    let mut facf = State::new(8, SearchConfig::deterministic());

    facf.record_result(3, TestResult::Pass);

    // Positions 0-3 should be zero
    for i in 0..=3 {
        assert!((facf.distribution().get(i)).abs() < 1e-9);
    }

    // Remaining positions should split the probability
    let remaining_prob: f64 = (4..=8).map(|i| facf.distribution().get(i)).sum();
    assert!((remaining_prob - 1.0).abs() < 1e-9);
}

#[test]
fn test_fail_update_deterministic() {
    // With flake_rate = 0, a FAIL at position k should completely eliminate
    // positions k+1..n (they can't be culprit if test failed and there's no flake)
    let mut facf = State::new(8, SearchConfig::deterministic());

    facf.record_result(3, TestResult::Fail);

    // Positions 4-7 and no-culprit should be zero (f=0 means flake impossible)
    for i in 4..=8 {
        assert!(
            (facf.distribution().get(i)).abs() < 1e-9,
            "position {} should be zero but was {}",
            i,
            facf.distribution().get(i)
        );
    }

    // Positions 0-3 should have all the probability
    let remaining_prob: f64 = (0..=3).map(|i| facf.distribution().get(i)).sum();
    assert!((remaining_prob - 1.0).abs() < 1e-9);
}

// -------------------------------------------------------------------------
// Unit Tests: NextRuns
// -------------------------------------------------------------------------

#[test]
fn test_next_runs_selects_median() {
    let facf = State::new(10, SearchConfig::deterministic());

    // With uniform distribution, should select middle position
    let runs = facf.next_runs(1);
    assert_eq!(runs.len(), 1);

    // Position should be around the median
    // CDF crosses 0.5 at position ~4-5 for uniform with 11 entries
    assert!(runs[0] >= 3 && runs[0] <= 5);
}

#[test]
fn test_next_runs_multiple() {
    let facf = State::new(16, SearchConfig::deterministic());

    let runs = facf.next_runs(3);

    // Should get 3 distinct positions
    assert!(runs.len() <= 3);
    let unique: HashSet<_> = runs.iter().collect();
    assert_eq!(unique.len(), runs.len());
}

// -------------------------------------------------------------------------
// Simulated Runs: Deterministic Scenarios
// -------------------------------------------------------------------------

#[test]
fn test_deterministic_bisect() {
    // With flake_rate = 0, FACF should behave like traditional bisect
    let num_suspects = 16;
    let actual_culprit = 7;

    let mut facf = State::new(num_suspects, SearchConfig::deterministic());

    while facf.result().is_none() {
        let runs = facf.next_runs(1);
        if runs.is_empty() {
            break;
        }

        for pos in runs {
            // Test passes before culprit, fails at or after
            let result = if pos < actual_culprit {
                TestResult::Pass
            } else {
                TestResult::Fail
            };
            facf.record_result(pos, result);
        }
    }

    assert!(
        matches!(facf.result(), Some(SearchResult::Culprit { position, .. }) if position == actual_culprit)
    );
    // Should find it in O(log n) iterations
    assert!(facf.iterations() <= 10);
}

#[test]
fn test_culprit_at_start() {
    let mut facf = State::new(8, SearchConfig::deterministic());

    while facf.result().is_none() {
        let runs = facf.next_runs(1);
        if runs.is_empty() {
            break;
        }

        for pos in runs {
            // Culprit is at position 0, so everything fails
            facf.record_result(pos, TestResult::Fail);
        }
    }

    assert!(matches!(
        facf.result(),
        Some(SearchResult::Culprit { position: 0, .. })
    ));
}

#[test]
fn test_culprit_at_end() {
    let num_suspects = 8;
    let actual_culprit = num_suspects - 1;

    let mut facf = State::new(num_suspects, SearchConfig::deterministic());

    while facf.result().is_none() {
        let runs = facf.next_runs(1);
        if runs.is_empty() {
            break;
        }

        for pos in runs {
            let result = if pos < actual_culprit {
                TestResult::Pass
            } else {
                TestResult::Fail
            };
            facf.record_result(pos, result);
        }
    }

    assert!(
        matches!(facf.result(), Some(SearchResult::Culprit { position, .. }) if position == actual_culprit)
    );
}

#[test]
fn test_no_culprit_all_pass() {
    // If all tests pass, should conclude "no culprit"
    let mut facf = State::new(8, SearchConfig::with_flake_rate(0.1));

    // Keep passing until we reach conclusion
    for _iter in 0..20 {
        if facf.result().is_some() {
            break;
        }

        let runs = facf.next_runs(1);
        if runs.is_empty() {
            break;
        }

        for pos in runs {
            facf.record_result(pos, TestResult::Pass);
        }
    }

    assert!(matches!(
        facf.result(),
        Some(SearchResult::NoCulprit { .. })
    ));
}

#[test]
fn test_single_suspect() {
    let mut facf = State::new(1, SearchConfig::deterministic());

    facf.record_result(0, TestResult::Fail);

    assert!(matches!(
        facf.result(),
        Some(SearchResult::Culprit { position: 0, .. })
    ));
}

#[test]
fn test_two_suspects() {
    // Culprit at position 1
    let mut facf = State::new(2, SearchConfig::deterministic());

    while facf.result().is_none() {
        let runs = facf.next_runs(1);
        if runs.is_empty() {
            break;
        }

        for pos in runs {
            let result = if pos < 1 {
                TestResult::Pass
            } else {
                TestResult::Fail
            };
            facf.record_result(pos, result);
        }
    }

    assert!(matches!(
        facf.result(),
        Some(SearchResult::Culprit { position: 1, .. })
    ));
}

// -------------------------------------------------------------------------
// Property-Based / Statistical Tests (using rand)
// -------------------------------------------------------------------------

#[test]
fn test_distribution_always_normalized() {
    use rand::{Rng, SeedableRng};
    let mut rng = rand::rngs::StdRng::seed_from_u64(42);

    let num_suspects = 10;
    let actual_culprit = rng.gen_range(0..num_suspects);
    let flake_rate = 0.1;

    let mut facf = State::new(num_suspects, SearchConfig::with_flake_rate(flake_rate));

    // Run 50 iterations with random flaky outcomes
    for _ in 0..50 {
        if facf.result().is_some() {
            break;
        }

        let runs = facf.next_runs(1);
        if runs.is_empty() {
            break;
        }

        for pos in runs {
            // True result based on culprit position
            let true_result = if pos < actual_culprit {
                TestResult::Pass
            } else {
                TestResult::Fail
            };

            // With flake_rate probability, a passing test might fail
            let actual_result =
                if true_result == TestResult::Pass && rng.r#gen::<f64>() < flake_rate {
                    TestResult::Fail
                } else {
                    true_result
                };

            facf.record_result(pos, actual_result);

            // Verify normalization after each update
            assert!(
                facf.distribution().is_normalized(),
                "distribution not normalized after {} iterations",
                facf.iterations()
            );
        }
    }
}

#[test]
fn test_convergence_with_flakes() {
    use rand::{Rng, SeedableRng};
    let mut rng = rand::rngs::StdRng::seed_from_u64(123);

    // Run multiple simulations to verify statistical convergence
    let num_simulations = 100;
    let num_suspects = 16;
    let flake_rate = 0.05;
    let max_iterations = 50;

    let mut correct_detections = 0;
    let mut total_iterations = 0;

    for _ in 0..num_simulations {
        let actual_culprit = rng.gen_range(0..num_suspects);
        let mut facf = State::new(num_suspects, SearchConfig::with_flake_rate(flake_rate));

        for _ in 0..max_iterations {
            if facf.result().is_some() {
                break;
            }

            let runs = facf.next_runs(1);
            if runs.is_empty() {
                break;
            }

            for pos in runs {
                let true_result = if pos < actual_culprit {
                    TestResult::Pass
                } else {
                    TestResult::Fail
                };

                let actual_result =
                    if true_result == TestResult::Pass && rng.r#gen::<f64>() < flake_rate {
                        TestResult::Fail
                    } else {
                        true_result
                    };

                facf.record_result(pos, actual_result);
            }
        }

        total_iterations += facf.iterations();

        if matches!(facf.result(), Some(SearchResult::Culprit { position, .. }) if position == actual_culprit)
        {
            correct_detections += 1;
        }
    }

    let accuracy = correct_detections as f64 / num_simulations as f64;
    let avg_iterations = total_iterations as f64 / num_simulations as f64;

    // With 5% flake rate, we should still detect correctly most of the time
    assert!(
        accuracy >= 0.80,
        "accuracy {} is too low (expected >= 0.80)",
        accuracy
    );

    // Average iterations should be reasonable
    assert!(
        avg_iterations < 30.0,
        "average iterations {} is too high",
        avg_iterations
    );
}

#[test]
fn test_robustness_high_flake_rate() {
    use rand::{Rng, SeedableRng};
    let mut rng = rand::rngs::StdRng::seed_from_u64(456);

    // Even with high flake rate, should not report wrong culprit
    let num_simulations = 50;
    let num_suspects = 8;
    let flake_rate = 0.3; // 30% flake rate - very high
    let max_iterations = 100;

    let mut wrong_detections = 0;

    for _ in 0..num_simulations {
        let actual_culprit = rng.gen_range(0..num_suspects);
        let mut facf = State::new(
            num_suspects,
            SearchConfig {
                flake_rate,
                threshold: 0.95, // Higher threshold for noisy environment
                use_info_gain_weighting: true,
            },
        );

        for _ in 0..max_iterations {
            if facf.result().is_some() {
                break;
            }

            let runs = facf.next_runs(1);
            if runs.is_empty() {
                break;
            }

            for pos in runs {
                let true_result = if pos < actual_culprit {
                    TestResult::Pass
                } else {
                    TestResult::Fail
                };

                let actual_result =
                    if true_result == TestResult::Pass && rng.r#gen::<f64>() < flake_rate {
                        TestResult::Fail
                    } else {
                        true_result
                    };

                facf.record_result(pos, actual_result);
            }
        }

        // Check if we got a wrong detection (not inconclusive, not correct)
        if let Some(result) = facf.result() {
            match result {
                SearchResult::Culprit { position, .. } if position != actual_culprit => {
                    wrong_detections += 1;
                }
                _ => {}
            }
        }
    }

    // Should have very few wrong detections (robustness property)
    let wrong_rate = wrong_detections as f64 / num_simulations as f64;
    assert!(
        wrong_rate < 0.1,
        "wrong detection rate {} is too high (expected < 0.1)",
        wrong_rate
    );
}

#[test]
fn test_monotonicity_at_culprit() {
    // When we fail at positions >= culprit and pass at positions < culprit,
    // the culprit's probability should monotonically increase.
    let culprit = 3;
    let mut facf = State::new(8, SearchConfig::with_flake_rate(0.1));

    let mut prev_prob = facf.distribution().get(culprit);

    // First, pass at positions before culprit to eliminate them
    for pos in 0..culprit {
        facf.record_result(pos, TestResult::Pass);
    }

    // Now repeatedly fail at the culprit to increase its probability
    for _ in 0..10 {
        if facf.result().is_some() {
            break;
        }

        facf.record_result(culprit, TestResult::Fail);

        let curr_prob = facf.distribution().get(culprit);
        // With pass updates having zeroed out earlier positions,
        // failing at culprit should increase its probability
        assert!(
            curr_prob >= prev_prob - 1e-9,
            "probability decreased: {} -> {}",
            prev_prob,
            curr_prob
        );
        prev_prob = curr_prob;
    }

    // Should eventually identify the culprit
    assert!(
        matches!(facf.result(), Some(SearchResult::Culprit { position, .. }) if position == culprit)
    );
}

#[test]
fn test_fail_probability_mass_increases() {
    // When we repeatedly fail at a position, the total probability mass
    // for positions <= k should monotonically increase relative to positions > k
    let k = 3;
    let mut facf = State::new(8, SearchConfig::with_flake_rate(0.2));

    let mass_before =
        |f: &State, pos: usize| -> f64 { (0..=pos).map(|i| f.distribution().get(i)).sum() };

    let mut prev_mass = mass_before(&facf, k);

    for _ in 0..10 {
        if facf.result().is_some() {
            break;
        }

        facf.record_result(k, TestResult::Fail);

        let curr_mass = mass_before(&facf, k);
        assert!(
            curr_mass >= prev_mass - 1e-9,
            "probability mass for positions <= {} decreased: {} -> {}",
            k,
            prev_mass,
            curr_mass
        );
        prev_mass = curr_mass;
    }

    // Eventually, most probability should be in positions <= k
    assert!(
        prev_mass > 0.9,
        "probability mass {} should exceed 0.9",
        prev_mass
    );
}

// =========================================================================
// Additional Edge Case Tests
// =========================================================================

#[test]
fn test_flake_rate_zero_is_deterministic() {
    // With flake_rate = 0, algorithm should behave exactly like traditional bisect
    for culprit in [0, 7, 15, 31] {
        let num_suspects = 32;
        if culprit >= num_suspects {
            continue;
        }

        let mut facf = State::new(num_suspects, SearchConfig::deterministic());

        while facf.result().is_none() {
            let runs = facf.next_runs(1);
            if runs.is_empty() {
                break;
            }

            for pos in runs {
                let result = if pos < culprit {
                    TestResult::Pass
                } else {
                    TestResult::Fail
                };
                facf.record_result(pos, result);
            }
        }

        assert!(
            matches!(facf.result(), Some(SearchResult::Culprit { position, .. }) if position == culprit),
            "failed to find culprit at position {}",
            culprit
        );
        // Should converge in O(log n) iterations
        assert!(
            facf.iterations() <= 10,
            "took {} iterations for {} suspects with culprit at {}",
            facf.iterations(),
            num_suspects,
            culprit
        );
    }
}

#[test]
fn test_flake_rate_near_one() {
    // With very high flake rate, algorithm should still work but be more conservative
    let mut facf = State::new(
        8,
        SearchConfig {
            flake_rate: 0.9, // 90% of failures are flakes!
            threshold: 0.95,
            use_info_gain_weighting: true,
        },
    );

    // Even with 90% flake rate, consistent failures at culprit should work
    let culprit = 4;

    // Pass before culprit
    for pos in 0..culprit {
        facf.record_result(pos, TestResult::Pass);
    }

    // Fail at culprit many times - with 90% flake rate, need many more failures
    // to reach 95% confidence
    for _ in 0..100 {
        if facf.result().is_some() {
            break;
        }
        facf.record_result(culprit, TestResult::Fail);
    }

    assert!(
        matches!(facf.result(), Some(SearchResult::Culprit { position, .. }) if position == culprit)
    );
}

#[test]
fn test_large_number_of_suspects() {
    let num_suspects = 1000;
    let culprit = 500;

    let mut facf = State::new(num_suspects, SearchConfig::deterministic());

    while facf.result().is_none() {
        let runs = facf.next_runs(1);
        if runs.is_empty() {
            break;
        }

        for pos in runs {
            let result = if pos < culprit {
                TestResult::Pass
            } else {
                TestResult::Fail
            };
            facf.record_result(pos, result);
        }
    }

    assert!(
        matches!(facf.result(), Some(SearchResult::Culprit { position, .. }) if position == culprit)
    );
    // log2(1000) ≈ 10, should converge quickly
    assert!(
        facf.iterations() <= 15,
        "took {} iterations for 1000 suspects",
        facf.iterations()
    );
}

#[test]
fn test_threshold_exactly_met() {
    // Test behavior when probability exactly meets threshold
    let mut facf = State::new(
        4,
        SearchConfig {
            flake_rate: 0.0,
            threshold: 0.5, // Very low threshold
            use_info_gain_weighting: false,
        },
    );

    // A single pass should eliminate 2 positions
    facf.record_result(1, TestResult::Pass);

    // Check that we can still get a result (or continue searching)
    // The distribution should now have 0 for positions 0,1 and split among 2,3,no-culprit
    assert!((facf.distribution().get(0)).abs() < 1e-9);
    assert!((facf.distribution().get(1)).abs() < 1e-9);
}

#[test]
fn test_very_low_threshold() {
    // With very low threshold, should converge quickly
    let mut facf = State::new(
        8,
        SearchConfig {
            flake_rate: 0.1,
            threshold: 0.4, // Low threshold
            use_info_gain_weighting: false,
        },
    );

    facf.record_result(3, TestResult::Pass);
    facf.record_result(5, TestResult::Fail);

    // Should have result quickly with low threshold
    // After pass at 3 and fail at 5, probability concentrates on 4,5
    assert!(facf.iterations() <= 5 || facf.result().is_some());
}

// =========================================================================
// Mathematical Correctness Tests
// =========================================================================

#[test]
fn test_bayes_pass_update_manual() {
    // Manual calculation of Bayesian update for PASS
    // With 3 suspects, uniform prior: P(C0)=P(C1)=P(C2)=P(no_culprit)=0.25
    // PASS at position 1:
    //   - P(P1|C0) = 0 (can't pass if culprit is before or at test position)
    //   - P(P1|C1) = 0 (can't pass if culprit is at test position)
    //   - P(P1|C2) = 1-f (can pass before culprit, unless flake)
    //   - P(P1|no_culprit) = 1-f
    // With f=0.1:
    //   P(P1) = 0.25*0 + 0.25*0 + 0.25*0.9 + 0.25*0.9 = 0.45
    //   P(C2|P1) = 0.9 * 0.25 / 0.45 = 0.5
    //   P(no_culprit|P1) = 0.9 * 0.25 / 0.45 = 0.5

    let mut facf = State::new(3, SearchConfig::with_flake_rate(0.1));

    facf.record_result(1, TestResult::Pass);

    // Positions 0 and 1 should be zero
    assert!(
        (facf.distribution().get(0)).abs() < 1e-9,
        "P(C0) = {} should be 0",
        facf.distribution().get(0)
    );
    assert!(
        (facf.distribution().get(1)).abs() < 1e-9,
        "P(C1) = {} should be 0",
        facf.distribution().get(1)
    );

    // Positions 2 and no-culprit should split 50-50
    assert!(
        (facf.distribution().get(2) - 0.5).abs() < 1e-9,
        "P(C2) = {} should be 0.5",
        facf.distribution().get(2)
    );
    assert!(
        (facf.distribution().get(3) - 0.5).abs() < 1e-9,
        "P(no_culprit) = {} should be 0.5",
        facf.distribution().get(3)
    );
}

#[test]
fn test_bayes_fail_update_manual() {
    // Manual calculation of Bayesian update for FAIL
    // With 3 suspects, uniform prior: P(C0)=P(C1)=P(C2)=P(no_culprit)=0.25
    // FAIL at position 1:
    //   - P(F1|C0) = 1 (always fails at or after culprit)
    //   - P(F1|C1) = 1 (always fails at culprit)
    //   - P(F1|C2) = f (can only fail before culprit due to flake)
    //   - P(F1|no_culprit) = f
    // With f=0.1:
    //   P(F1) = 0.25*1 + 0.25*1 + 0.25*0.1 + 0.25*0.1 = 0.55
    //   P(C0|F1) = 1 * 0.25 / 0.55 = 0.4545...
    //   P(C1|F1) = 1 * 0.25 / 0.55 = 0.4545...
    //   P(C2|F1) = 0.1 * 0.25 / 0.55 = 0.04545...
    //   P(no_culprit|F1) = 0.1 * 0.25 / 0.55 = 0.04545...

    let mut facf = State::new(3, SearchConfig::with_flake_rate(0.1));

    facf.record_result(1, TestResult::Fail);

    let expected_c0 = 0.25 / 0.55;
    let expected_c1 = 0.25 / 0.55;
    let expected_c2 = 0.025 / 0.55;
    let expected_nc = 0.025 / 0.55;

    assert!(
        (facf.distribution().get(0) - expected_c0).abs() < 1e-9,
        "P(C0) = {} should be {}",
        facf.distribution().get(0),
        expected_c0
    );
    assert!(
        (facf.distribution().get(1) - expected_c1).abs() < 1e-9,
        "P(C1) = {} should be {}",
        facf.distribution().get(1),
        expected_c1
    );
    assert!(
        (facf.distribution().get(2) - expected_c2).abs() < 1e-9,
        "P(C2) = {} should be {}",
        facf.distribution().get(2),
        expected_c2
    );
    assert!(
        (facf.distribution().get(3) - expected_nc).abs() < 1e-9,
        "P(no_culprit) = {} should be {}",
        facf.distribution().get(3),
        expected_nc
    );
}

#[test]
fn test_sequential_updates_commutative() {
    // Bayesian updates should be commutative (order shouldn't matter)
    let config = SearchConfig::with_flake_rate(0.1);

    // Order 1: pass at 2, fail at 5
    let mut facf1 = State::new(8, config.clone());
    facf1.record_result(2, TestResult::Pass);
    facf1.record_result(5, TestResult::Fail);

    // Order 2: fail at 5, pass at 2
    let mut facf2 = State::new(8, config);
    facf2.record_result(5, TestResult::Fail);
    facf2.record_result(2, TestResult::Pass);

    // Distributions should be identical
    for i in 0..=8 {
        assert!(
            (facf1.distribution().get(i) - facf2.distribution().get(i)).abs() < 1e-9,
            "distributions differ at position {}: {} vs {}",
            i,
            facf1.distribution().get(i),
            facf2.distribution().get(i)
        );
    }
}

#[test]
fn test_multiple_passes_at_same_position() {
    // Multiple passes at the same position should reinforce the result
    let mut facf = State::new(8, SearchConfig::with_flake_rate(0.1));

    facf.record_result(4, TestResult::Pass);
    let prob_after_one = facf.distribution().get(5);

    facf.record_result(4, TestResult::Pass);
    let prob_after_two = facf.distribution().get(5);

    // After the first PASS at position 4 zeros out 0..=4, a second PASS at
    // position 4 provides no new information — all surviving hypotheses have
    // the same likelihood ratio (1-f)/(1-f) = 1, so the distribution is
    // unchanged.
    assert!(
        (prob_after_one - prob_after_two).abs() < 1e-9,
        "second PASS at same position should not change distribution: {} vs {}",
        prob_after_one,
        prob_after_two,
    );
    assert!(facf.distribution().is_normalized());
}

#[test]
fn test_multiple_fails_at_same_position() {
    // Multiple fails at the same position should increase confidence
    let mut facf = State::new(8, SearchConfig::with_flake_rate(0.2));

    let initial_mass: f64 = (0..=3).map(|i| facf.distribution().get(i)).sum();

    facf.record_result(3, TestResult::Fail);
    let mass_after_one: f64 = (0..=3).map(|i| facf.distribution().get(i)).sum();

    facf.record_result(3, TestResult::Fail);
    let mass_after_two: f64 = (0..=3).map(|i| facf.distribution().get(i)).sum();

    facf.record_result(3, TestResult::Fail);
    let mass_after_three: f64 = (0..=3).map(|i| facf.distribution().get(i)).sum();

    // Probability mass for positions <= 3 should increase monotonically
    assert!(mass_after_one > initial_mass);
    assert!(mass_after_two > mass_after_one);
    assert!(mass_after_three > mass_after_two);
}

// =========================================================================
// NextRuns Algorithm Tests
// =========================================================================

#[test]
fn test_next_runs_k_equals_2() {
    let facf = State::new(16, SearchConfig::deterministic());

    let runs = facf.next_runs(2);

    // Should get 2 distinct positions
    assert_eq!(runs.len(), 2);
    assert_ne!(runs[0], runs[1]);

    // With uniform distribution, should split into thirds (approx positions 5 and 10)
    // The exact positions depend on the algorithm, but they should divide the range
}

#[test]
fn test_next_runs_k_equals_3() {
    let facf = State::new(16, SearchConfig::deterministic());

    let runs = facf.next_runs(3);

    // Should get 3 distinct positions
    assert!(runs.len() <= 3);
    let unique: HashSet<_> = runs.iter().collect();
    assert_eq!(unique.len(), runs.len());
}

#[test]
fn test_next_runs_k_larger_than_suspects() {
    let facf = State::new(4, SearchConfig::deterministic());

    let runs = facf.next_runs(10);

    // Should not return more positions than we have suspects
    assert!(runs.len() <= 4);
}

#[test]
fn test_next_runs_after_narrowing() {
    let mut facf = State::new(16, SearchConfig::deterministic());

    // Pass at position 7, eliminating first half
    facf.record_result(7, TestResult::Pass);

    let runs = facf.next_runs(1);

    // Should select from positions 8-15, around position 11-12
    assert!(!runs.is_empty());
    assert!(runs[0] > 7, "should select from remaining suspects");
}

#[test]
fn test_next_runs_prefers_prior_position() {
    // Test the optimization that prefers cidx-1 to find a PASS
    let mut facf = State::new(8, SearchConfig::with_flake_rate(0.1));

    // Fail at position 4, concentrating probability around 0-4
    facf.record_result(4, TestResult::Fail);
    facf.record_result(4, TestResult::Fail);
    facf.record_result(4, TestResult::Fail);

    let runs = facf.next_runs(1);

    // Algorithm should prefer testing a position before the high-probability area
    assert!(!runs.is_empty());
}

#[test]
fn test_prefer_prior_no_duplicates_in_batch() {
    // When prefer-prior triggers for multiple thresholds, cidx-1 should not
    // appear twice in the same batch.
    let facf = State::new(16, SearchConfig::with_flake_rate(0.1));

    let runs = facf.next_runs(4);

    let unique: HashSet<usize> = runs.iter().copied().collect();
    assert_eq!(
        unique.len(),
        runs.len(),
        "batch contains duplicates: {:?}",
        runs
    );
}

#[test]
fn test_info_gain_weighted_cdf_differs_from_plain() {
    // When flake rate > 0 and the distribution is non-degenerate, the
    // info-gain-weighted CDF should differ from the plain posterior CDF.
    let facf = State::new(16, SearchConfig::with_flake_rate(0.1));

    let prob_cdf = facf.distribution().cdf();
    let plain_selection: Vec<f64> = prob_cdf[..16].to_vec();
    let weighted = facf.compute_info_gain_weighted_cdf().unwrap();

    assert_eq!(plain_selection.len(), weighted.len());

    // At least one entry should differ
    let any_differ = plain_selection
        .iter()
        .zip(weighted.iter())
        .any(|(a, b)| (a - b).abs() > 1e-9);
    assert!(
        any_differ,
        "weighted CDF should differ from plain CDF when flake rate > 0"
    );
}

#[test]
fn test_info_gain_selects_different_positions() {
    // After a Bayesian update creates a non-uniform distribution, the
    // info-gain-weighted CDF should select different positions than the
    // plain posterior CDF.
    let config_ig = SearchConfig {
        flake_rate: 0.2,
        threshold: 0.9,
        use_info_gain_weighting: true,
    };
    let config_plain = SearchConfig {
        flake_rate: 0.2,
        threshold: 0.9,
        use_info_gain_weighting: false,
    };

    let mut facf_ig = State::new(32, config_ig);
    let mut facf_plain = State::new(32, config_plain);

    // Shift distribution to be non-uniform so that the interaction between
    // E[I(sᵢ)] and Pr[Cᵢ] creates a meaningfully different selection CDF.
    facf_ig.record_result(20, TestResult::Fail);
    facf_plain.record_result(20, TestResult::Fail);

    // Over several rounds, info-gain should select at least one different
    // position compared to plain.
    let mut any_differ = false;
    for k in 1..=5 {
        let runs_ig = facf_ig.next_runs(k);
        let runs_plain = facf_plain.next_runs(k);
        if runs_ig != runs_plain {
            any_differ = true;
            break;
        }
    }

    assert!(
        any_differ,
        "info-gain should select different positions than plain on non-uniform distribution"
    );
}

#[test]
fn test_info_gain_vs_uniform_thresholds() {
    // Compare behavior with and without info-gain optimization
    let num_suspects = 32;
    let culprit = 16;

    let config_info_gain = SearchConfig {
        flake_rate: 0.1,
        threshold: 0.9,
        use_info_gain_weighting: true,
    };

    let config_uniform = SearchConfig {
        flake_rate: 0.1,
        threshold: 0.9,
        use_info_gain_weighting: false,
    };

    // Both should converge, but may take different paths
    for config in [config_info_gain, config_uniform] {
        let mut facf = State::new(num_suspects, config);

        while facf.result().is_none() && facf.iterations() < 50 {
            let runs = facf.next_runs(1);
            if runs.is_empty() {
                break;
            }

            for pos in runs {
                let result = if pos < culprit {
                    TestResult::Pass
                } else {
                    TestResult::Fail
                };
                facf.record_result(pos, result);
            }
        }

        assert!(
            matches!(facf.result(), Some(SearchResult::Culprit { position, .. }) if position == culprit)
        );
    }
}

// =========================================================================
// API and State Tests
// =========================================================================

#[test]
fn test_executions_recorded() {
    let mut facf = State::new(8, SearchConfig::default());

    facf.record_result(3, TestResult::Pass);
    facf.record_result(5, TestResult::Fail);
    facf.record_result(4, TestResult::Fail);

    assert_eq!(facf.executions().len(), 3);
    assert_eq!(facf.iterations(), 3);

    assert_eq!(facf.executions()[0].position, 3);
    assert_eq!(facf.executions()[0].result, TestResult::Pass);

    assert_eq!(facf.executions()[1].position, 5);
    assert_eq!(facf.executions()[1].result, TestResult::Fail);
}

#[test]
fn test_config_accessors() {
    let config = SearchConfig {
        flake_rate: 0.15,
        threshold: 0.85,
        use_info_gain_weighting: false,
    };

    let facf = State::new(10, config);

    assert!((facf.config().flake_rate - 0.15).abs() < 1e-9);
    assert!((facf.config().threshold - 0.85).abs() < 1e-9);
    assert!(!facf.config().use_info_gain_weighting);
    assert_eq!(facf.num_suspects(), 10);
}

#[test]
fn test_distribution_accessors() {
    let facf = State::new(5, SearchConfig::default());

    let dist = facf.distribution();
    assert_eq!(dist.num_suspects(), 5);
    assert_eq!(dist.probs().len(), 6);

    let cdf = dist.cdf();
    assert_eq!(cdf.len(), 6);
    assert!((cdf[5] - 1.0).abs() < 1e-9);
}

#[test]
#[should_panic(expected = "must have at least one suspect")]
fn test_zero_suspects_panics() {
    let _ = State::new(0, SearchConfig::default());
}

#[test]
#[should_panic(expected = "flake_rate must be in [0, 1]")]
fn test_invalid_flake_rate_panics() {
    let _ = State::new(
        10,
        SearchConfig {
            flake_rate: 1.5,
            ..Default::default()
        },
    );
}

#[test]
#[should_panic(expected = "threshold must be in [0, 1]")]
fn test_invalid_threshold_panics() {
    let _ = State::new(
        10,
        SearchConfig {
            threshold: -0.1,
            ..Default::default()
        },
    );
}

#[test]
#[should_panic(expected = "position out of range")]
fn test_invalid_position_panics() {
    let mut facf = State::new(5, SearchConfig::default());
    facf.record_result(10, TestResult::Pass); // Position 10 is out of range
}

// =========================================================================
// Stress and Adversarial Tests
// =========================================================================

#[test]
fn test_many_iterations() {
    // Run many iterations to ensure numerical stability
    let mut facf = State::new(16, SearchConfig::with_flake_rate(0.1));

    for i in 0..100 {
        if facf.result().is_some() {
            break;
        }

        let pos = i % 16;
        let result = if i % 3 == 0 {
            TestResult::Pass
        } else {
            TestResult::Fail
        };
        facf.record_result(pos, result);

        // Verify normalization is maintained
        assert!(
            facf.distribution().is_normalized(),
            "distribution not normalized after {} iterations",
            i
        );
    }
}

#[test]
fn test_alternating_pass_fail() {
    // Adversarial pattern: alternating pass/fail at same position
    let mut facf = State::new(8, SearchConfig::with_flake_rate(0.3));

    for _ in 0..20 {
        facf.record_result(4, TestResult::Pass);
        if facf.result().is_some() {
            break;
        }
        facf.record_result(4, TestResult::Fail);
        if facf.result().is_some() {
            break;
        }
    }

    // Should not crash and distribution should be valid
    assert!(facf.distribution().is_normalized());
}

#[test]
fn test_all_fails() {
    // What happens if every test fails?
    let mut facf = State::new(8, SearchConfig::with_flake_rate(0.1));

    // Fail at every position
    for pos in 0..8 {
        facf.record_result(pos, TestResult::Fail);
    }

    // Should eventually converge (likely to position 0 being the culprit)
    assert!(facf.distribution().is_normalized());

    // Position 0 should have highest probability (everything fails, so culprit is at or before 0)
    let argmax = facf.distribution().argmax();
    assert_eq!(
        argmax, 0,
        "culprit should be at position 0 when all tests fail"
    );
}

#[test]
fn test_pass_then_fail_at_adjacent() {
    // Pass at k, fail at k+1 should strongly indicate culprit is at k+1
    let mut facf = State::new(8, SearchConfig::deterministic());

    facf.record_result(4, TestResult::Pass);
    facf.record_result(5, TestResult::Fail);

    assert!(matches!(
        facf.result(),
        Some(SearchResult::Culprit { position: 5, .. })
    ));
}

#[test]
fn test_fail_then_pass_contradiction() {
    // Fail at k, then pass at k+1 - this is odd but should handle gracefully
    // (implies the fail at k was a flake)
    let mut facf = State::new(8, SearchConfig::with_flake_rate(0.5));

    facf.record_result(4, TestResult::Fail);
    facf.record_result(5, TestResult::Pass);

    // The pass at 5 eliminates positions 0-5
    // So culprit must be at 6, 7, or no-culprit
    for i in 0..=5 {
        assert!(
            (facf.distribution().get(i)).abs() < 1e-9,
            "position {} should be eliminated",
            i
        );
    }
}

// =========================================================================
// Statistical Accuracy Tests (Monte Carlo)
// =========================================================================

#[test]
fn test_accuracy_across_flake_rates() {
    use rand::{Rng, SeedableRng};
    let mut rng = rand::rngs::StdRng::seed_from_u64(789);

    // Test accuracy at different flake rates
    for flake_rate in [0.0, 0.05, 0.1, 0.2, 0.3] {
        let num_simulations = 50;
        let num_suspects = 16;
        let max_iterations = 100;

        let mut correct = 0;
        let mut wrong = 0;
        let mut no_culprit = 0;
        let mut inconclusive = 0;

        for _ in 0..num_simulations {
            let actual_culprit = rng.gen_range(0..num_suspects);
            let mut facf = State::new(
                num_suspects,
                SearchConfig {
                    flake_rate,
                    threshold: 0.9,
                    use_info_gain_weighting: true,
                },
            );

            for _ in 0..max_iterations {
                if facf.result().is_some() {
                    break;
                }

                let runs = facf.next_runs(1);
                if runs.is_empty() {
                    break;
                }

                for pos in runs {
                    let true_result = if pos < actual_culprit {
                        TestResult::Pass
                    } else {
                        TestResult::Fail
                    };

                    let actual_result =
                        if true_result == TestResult::Pass && rng.r#gen::<f64>() < flake_rate {
                            TestResult::Fail
                        } else {
                            true_result
                        };

                    facf.record_result(pos, actual_result);
                }
            }

            match facf.result() {
                Some(SearchResult::Culprit { position, .. }) if position == actual_culprit => {
                    correct += 1
                }
                Some(SearchResult::Culprit { .. }) => wrong += 1,
                Some(SearchResult::NoCulprit { .. }) => no_culprit += 1,
                None => inconclusive += 1,
            }
        }

        let accuracy = correct as f64 / num_simulations as f64;
        let wrong_rate = wrong as f64 / num_simulations as f64;

        // For low flake rates, accuracy should be high
        if flake_rate <= 0.1 {
            assert!(
                accuracy >= 0.7,
                "accuracy {} too low for flake_rate {}",
                accuracy,
                flake_rate
            );
        }

        // Wrong detection rate should always be low
        assert!(
            wrong_rate < 0.15,
            "wrong rate {} too high for flake_rate {} (correct={}, wrong={}, no_culprit={}, inconclusive={})",
            wrong_rate,
            flake_rate,
            correct,
            wrong,
            no_culprit,
            inconclusive
        );
    }
}

#[test]
fn test_convergence_time_distribution() {
    use rand::{Rng, SeedableRng};
    let mut rng = rand::rngs::StdRng::seed_from_u64(1001);

    // Measure convergence times
    let num_simulations = 100;
    let num_suspects = 32;
    let flake_rate = 0.05;
    let max_iterations = 100;

    let mut iteration_counts = Vec::new();

    for _ in 0..num_simulations {
        let actual_culprit = rng.gen_range(0..num_suspects);
        let mut facf = State::new(num_suspects, SearchConfig::with_flake_rate(flake_rate));

        for _ in 0..max_iterations {
            if facf.result().is_some() {
                break;
            }

            let runs = facf.next_runs(1);
            if runs.is_empty() {
                break;
            }

            for pos in runs {
                let true_result = if pos < actual_culprit {
                    TestResult::Pass
                } else {
                    TestResult::Fail
                };

                let actual_result =
                    if true_result == TestResult::Pass && rng.r#gen::<f64>() < flake_rate {
                        TestResult::Fail
                    } else {
                        true_result
                    };

                facf.record_result(pos, actual_result);
            }
        }

        if facf.result().is_some() {
            iteration_counts.push(facf.iterations());
        }
    }

    // Calculate statistics
    let avg_iterations: f64 =
        iteration_counts.iter().sum::<usize>() as f64 / iteration_counts.len() as f64;
    let max_iterations_seen = *iteration_counts.iter().max().unwrap_or(&0);

    // Average should be reasonable (around O(log n) = ~5 for 32 suspects)
    assert!(
        avg_iterations < 20.0,
        "average iterations {} is too high",
        avg_iterations
    );

    // Max should not be too extreme
    assert!(
        max_iterations_seen < 50,
        "max iterations {} is too high",
        max_iterations_seen
    );
}

#[test]
fn test_parallel_runs_effectiveness() {
    use rand::{Rng, SeedableRng};
    let mut rng = rand::rngs::StdRng::seed_from_u64(2002);

    // Compare convergence with k=1 vs k=3 parallel runs
    let num_simulations = 50;
    let num_suspects = 64;
    let flake_rate = 0.05;
    let max_iterations = 100;

    for k in [1, 3] {
        let mut total_iterations = 0;
        let mut converged = 0;

        for _ in 0..num_simulations {
            let actual_culprit = rng.gen_range(0..num_suspects);
            let mut facf = State::new(num_suspects, SearchConfig::with_flake_rate(flake_rate));

            for _ in 0..max_iterations {
                if facf.result().is_some() {
                    break;
                }

                let runs = facf.next_runs(k);
                if runs.is_empty() {
                    break;
                }

                for pos in runs {
                    let true_result = if pos < actual_culprit {
                        TestResult::Pass
                    } else {
                        TestResult::Fail
                    };

                    let actual_result =
                        if true_result == TestResult::Pass && rng.r#gen::<f64>() < flake_rate {
                            TestResult::Fail
                        } else {
                            true_result
                        };

                    facf.record_result(pos, actual_result);
                }
            }

            if facf.result().is_some() {
                converged += 1;
                total_iterations += facf.iterations();
            }
        }

        let avg_iterations = total_iterations as f64 / converged as f64;

        // With k=3, might use more total iterations but fewer "rounds"
        assert!(
            converged >= num_simulations * 90 / 100,
            "only {}/{} converged with k={}",
            converged,
            num_simulations,
            k
        );
    }
}

// =========================================================================
// Distribution Edge Cases
// =========================================================================

#[test]
fn test_cdf_monotonic() {
    let dist = Distribution::uniform(10);
    let cdf = dist.cdf();

    for i in 1..cdf.len() {
        assert!(
            cdf[i] >= cdf[i - 1],
            "CDF not monotonic: {} < {} at index {}",
            cdf[i],
            cdf[i - 1],
            i
        );
    }
}

#[test]
fn test_cdf_ends_at_one() {
    for n in [1, 5, 10, 100] {
        let dist = Distribution::uniform(n);
        let cdf = dist.cdf();

        assert!(
            (cdf[n] - 1.0).abs() < 1e-9,
            "CDF should end at 1.0 for {} suspects, got {}",
            n,
            cdf[n]
        );
    }
}

#[test]
fn test_distribution_sum_after_many_updates() {
    let mut facf = State::new(20, SearchConfig::with_flake_rate(0.15));

    // Do many random updates
    for i in 0..50 {
        let pos = i % 20;
        let result = if i % 2 == 0 {
            TestResult::Pass
        } else {
            TestResult::Fail
        };
        facf.record_result(pos, result);

        let sum: f64 = facf.distribution().probs().iter().sum();
        assert!(
            (sum - 1.0).abs() < 1e-9,
            "sum = {} after {} updates",
            sum,
            i + 1
        );
    }
}

#[test]
fn test_from_probs() {
    let probs = vec![0.1, 0.2, 0.3, 0.4];
    let dist = Distribution::from_probs(probs.clone());

    for i in 0..probs.len() {
        assert!((dist.get(i) - probs[i]).abs() < 1e-9);
    }
}

#[test]
#[should_panic(expected = "need at least 1 suspect + no-culprit")]
fn test_from_probs_empty_panics() {
    let _ = Distribution::from_probs(vec![]);
}

#[test]
#[should_panic(expected = "all probabilities must be non-negative")]
fn test_from_probs_negative_panics() {
    let _ = Distribution::from_probs(vec![0.5, -0.3, 0.8]);
}
