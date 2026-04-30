package com.openrealm.data.controller;

import java.util.List;

import javax.servlet.http.HttpServletRequest;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.openrealm.data.auth.PlayerIdentityFilter;
import com.openrealm.data.dto.CharacterDto;
import com.openrealm.data.dto.ChestDto;
import com.openrealm.data.dto.PlayerAccountDto;
import com.openrealm.data.service.PlayerDataService;
import com.openrealm.data.util.AdminRestricted;
import com.openrealm.data.util.ApiUtils;
import com.openrealm.data.util.ErrorResponseObject;

@RestController
@RequestMapping("/data")
public class PlayerDataController {

    private final transient PlayerDataService playerDataService;
    private final transient PlayerIdentityFilter authFilter;

    public PlayerDataController(@Autowired PlayerDataService playerDataService, @Autowired final PlayerIdentityFilter authFilter) {
        this.playerDataService = playerDataService;
        this.authFilter = authFilter;
    }
    
    @GetMapping(value = "/stats/top", produces = { "application/json" })
    public ResponseEntity<?> getTopCharacters(final HttpServletRequest request, @RequestParam(defaultValue="25") final Integer count) {
        ResponseEntity<?> res = null;
        try {
            res = ApiUtils.buildSuccess(this.playerDataService.getTopCharacters(count));
        } catch (Exception e) {
            e.printStackTrace();
            res = ApiUtils.buildAndLogError("Failed to get top characters", e.getMessage());
        }
        return res;
    }

    @GetMapping(value = "/account/{accountUuid}", produces = { "application/json" })
    public ResponseEntity<?> getPlayerAccount(final HttpServletRequest request, @PathVariable final String accountUuid) {
        ResponseEntity<?> res = null;
        try {
            if (!this.authFilter.accountGuidMatch(accountUuid, request)) {
                throw new Exception("Invalid token");
            }
            res = ApiUtils.buildSuccess(this.playerDataService.getAccountByUuid(accountUuid));
        } catch (Exception e) {
            res = ApiUtils.buildAndLogError("Failed to find account", e.getMessage());
        }
        return res;
    }

    @GetMapping(value = "/account/{accountUuid}/character", produces = { "application/json" })
    public ResponseEntity<?> getPlayerAccountCharacters(final HttpServletRequest request, @PathVariable final String accountUuid) {
        ResponseEntity<?> res = null;
        try {
            if (!this.authFilter.accountGuidMatch(accountUuid, request)) {
                throw new Exception("Invalid token");
            }
            res = ApiUtils.buildSuccess(this.playerDataService.getPlayerCharacters(accountUuid));
        } catch (Exception e) {
            res = ApiUtils.buildAndLogError("Failed to get player characters", e.getMessage());
        }
        return res;
    }

    @PostMapping(value = "/account/{accountUuid}/character", produces = { "application/json" })
    public ResponseEntity<?> createPlayerAccountCharacter(final HttpServletRequest request, @PathVariable final String accountUuid,
            @RequestParam Integer classId) {
        ResponseEntity<?> res = null;
        try {
            if (!this.authFilter.accountGuidMatch(accountUuid, request)) {
                throw new Exception("Invalid token");
            }
            res = ApiUtils.buildSuccess(this.playerDataService.createCharacter(accountUuid, classId));
        } catch (Exception e) {
            res = ApiUtils.buildAndLogError("Failed to create character", e.getMessage());
        }
        return res;
    }

    @PostMapping(value = "/account", produces = { "application/json" })
    @AdminRestricted
    public ResponseEntity<?> saveAccountData(final HttpServletRequest request, @RequestBody final PlayerAccountDto account) {
        ResponseEntity<?> res = null;
        try {
            if (!this.authFilter.accountGuidMatch(account.getAccountUuid(), request)) {
                throw new Exception("Invalid token");
            }
            res = ApiUtils.buildSuccess(this.playerDataService.saveAccount(account));
        } catch (Exception e) {
            res = ApiUtils.buildAndLogError("Failed to save account", e.getMessage());
        }
        return res;
    }

    @PostMapping(value = "/account/character/{characterUuid}", produces = { "application/json" })
    @AdminRestricted
    public ResponseEntity<?> saveCharacterStatsData(final HttpServletRequest request, @PathVariable String characterUuid,
            @RequestBody final CharacterDto character) {
        ResponseEntity<?> res = null;
        try {
            res = ApiUtils.buildSuccess(this.playerDataService.saveCharacterStats(request, characterUuid, character));
        } catch (Exception e) {

            res = ApiUtils.buildAndLogError("Failed to save character stats", e.getMessage());
            e.printStackTrace();
        }
        return res;
    }

    @PostMapping(value = "/account/{accountUuid}/chest", produces = { "application/json" })
    public ResponseEntity<?> saveCharacterStatsData(final HttpServletRequest request, @PathVariable String accountUuid,
            @RequestBody final List<ChestDto> chests) {
        ResponseEntity<?> res = null;
        try {
            if (!this.authFilter.accountGuidMatch(accountUuid, request)) {
                throw new Exception("Invalid token");
            }
            res = ApiUtils.buildSuccess(this.playerDataService.saveChests(accountUuid, chests));
        } catch (Exception e) {

            res = ApiUtils.buildAndLogError("Failed to save account chests", e.getMessage());
            e.printStackTrace();
        }
        return res;
    }

    @PostMapping(value = "/account/{accountUuid}/chest/new", produces = { "application/json" })
    public ResponseEntity<?> saveCharacterStatsData(final HttpServletRequest request, @PathVariable String accountUuid) {
        ResponseEntity<?> res = null;
        try {
            if (!this.authFilter.accountGuidMatch(accountUuid, request)) {
                throw new Exception("Invalid token");
            }
            res = ApiUtils.buildSuccess(this.playerDataService.createChest(accountUuid));
        } catch (Exception e) {

            res = ApiUtils.buildAndLogError("Failed to create account chest", e.getMessage());
            e.printStackTrace();
        }
        return res;
    }

    /**
     * Spend account fame. Used by the game server to charge for fame-shop
     * purchases. Requires admin/data-server credentials — never invoked
     * directly by the webclient (purchases go through the game server's
     * BuyFameItem packet, which validates inventory and grants the item only
     * after this call succeeds). Returns the new account fame total.
     */
    @PostMapping(value = "/account/{accountUuid}/fame/spend", produces = { "application/json" })
    @AdminRestricted
    public ResponseEntity<?> spendFame(final HttpServletRequest request, @PathVariable final String accountUuid,
            @RequestParam("amount") final long amount) {
        ResponseEntity<?> res = null;
        try {
            final Long newTotal = this.playerDataService.spendAccountFame(accountUuid, amount);
            res = ApiUtils.buildSuccess(newTotal);
        } catch (Exception e) {
            res = ApiUtils.buildAndLogError("Failed to spend fame", e.getMessage());
        }
        return res;
    }

    /**
     * Admin-only: award account fame to a specific account. Used by the
     * in-game /fame command. Returns the updated total.
     */
    @PostMapping(value = "/account/{accountUuid}/fame/grant", produces = { "application/json" })
    @AdminRestricted
    public ResponseEntity<?> grantFame(final HttpServletRequest request, @PathVariable final String accountUuid,
            @RequestParam("amount") final long amount) {
        ResponseEntity<?> res = null;
        try {
            final Long newTotal = this.playerDataService.grantAccountFame(accountUuid, amount);
            res = ApiUtils.buildSuccess(newTotal);
        } catch (Exception e) {
            res = ApiUtils.buildAndLogError("Failed to grant fame", e.getMessage());
        }
        return res;
    }

    @DeleteMapping(value = "/account/character/{characterUuid}", produces = { "application/json" })
    public ResponseEntity<?> deleteCharacter(final HttpServletRequest request, @PathVariable String characterUuid,
            @RequestParam(name = "bankFame", required = false, defaultValue = "false") boolean bankFame,
            @RequestParam(name = "fameAmount", required = false) Long fameAmount) {
        ResponseEntity<?> res = null;
        try {
            this.playerDataService.deleteCharacter(request, characterUuid, bankFame, fameAmount);

            res = ApiUtils.buildSuccess(ErrorResponseObject.builder().message("successfully deleted character " + characterUuid)
                    .reason("Character deleted").status(HttpStatus.OK).build());
        } catch (Exception e) {

            res = ApiUtils.buildAndLogError("Failed to save character stats", e.getMessage());
            e.printStackTrace();
        }
        return res;
    }
}
